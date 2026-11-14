# GitHub Actions → AWS via OIDC. No stored keys anywhere: workflows exchange
# a short-lived GitHub token for AWS credentials, scoped by role trust policy.
#
# Two roles, deliberately asymmetric:
#   ops-gh-plan  — read-only + state lock; assumable from PRs and main pushes.
#   ops-gh-apply — can change infra; assumable ONLY through the GitHub
#                  "prod" environment (which is where human gates attach).

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS validates GitHub's cert against trusted root CAs and ignores this
  # list for this provider, but the API still requires a value.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  # GitHub's OIDC sub claim now embeds immutable owner/repo IDs
  # (repo:owner@ownerId/name@repoId:...), which pins trust to THIS repo even
  # if the name is ever released and re-registered by someone else. The
  # plain-name form is kept as a fallback for the legacy claim format.
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]
  github_sub_prefixes = [
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}",
    "repo:${var.github_repo}",
  ]

  # Every IAM name the boardwalk creates starts with a plank prefix. The apply
  # role may only touch IAM inside these namespaces — it cannot mint or edit
  # unrelated roles (including humans' and its own: 'ops-gh-*' is carved out).
  plank_iam_prefixes = ["mwa-*", "gai-*", "hub-*", "idp-*", "evt-*", "dla-*", "apx-*", "ctr-*", "sec-*", "net-*", "rdb-*", "fmw-*", "www-*", "ops-*", "platform-*"]
  plank_role_arns    = [for p in local.plank_iam_prefixes : "arn:aws:iam::${local.account_id}:role/${p}"]
  plank_policy_arns  = [for p in local.plank_iam_prefixes : "arn:aws:iam::${local.account_id}:policy/${p}"]

  # The prefixes fence NAMES. What a role may DO is fenced by the permissions
  # boundary below, which lives outside every plank prefix so the apply role
  # has no write path to it. Every other root spells this ARN out the same way
  # (local.role_boundary_arn in its versions.tf).
  role_boundary_name = "boardwalk-role-boundary"
  role_boundary_arn  = "arn:aws:iam::${local.account_id}:policy/${local.role_boundary_name}"

  # Plank 8's boundary exhibit is the one role with a different, far tighter
  # ceiling (S3 reads + its own logs). The apply role may keep managing that
  # role, but only while it carries exactly that boundary, and may not edit
  # the boundary policy itself (FrozenBoundaries below).
  exhibit_role_arn     = "arn:aws:iam::${local.account_id}:role/sec-boundary-demo"
  exhibit_boundary_arn = "arn:aws:iam::${local.account_id}:policy/sec-permission-boundary"

  # The IAM calls that decide what a role can do. Each supports the
  # iam:PermissionsBoundary condition key, so each can be made conditional on
  # the role carrying an approved boundary.
  role_power_actions = [
    "iam:CreateRole", "iam:PutRolePermissionsBoundary",
    "iam:PutRolePolicy", "iam:DeleteRolePolicy",
    "iam:AttachRolePolicy", "iam:DetachRolePolicy",
  ]

  # What only the owner may change: the account's own record and the
  # tripwires that read it (account-baseline.tf, account-alerts.tf). An audit
  # trail the least-trusted principal can pause is not much of one, so these
  # denies are attached twice. On the apply role they stop the pipeline. In
  # the boundary they stop every role the pipeline can create, which closes
  # the detour of minting a role that does it instead. Reads stay open, so
  # terraform can still refresh all of it and CI's plan still shows drift.
  owner_only = [
    {
      Sid    = "AuditTrailStaysOn"
      Effect = "Deny"
      Action = [
        "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors", "cloudtrail:PutInsightSelectors",
      ]
      Resource = local.audit_trail_arn
    },
    {
      # Everything S3 offers except reading. CloudTrail delivers as a service
      # principal and lifecycle expiry is S3's own; neither is an IAM role.
      Sid       = "AuditLogIsReadOnly"
      Effect    = "Deny"
      NotAction = ["s3:Get*", "s3:List*"]
      Resource  = [aws_s3_bucket.audit.arn, "${aws_s3_bucket.audit.arn}/*"]
    },
    {
      # One action covers both setting and deleting the account-wide block.
      Sid      = "PublicAccessBlockStaysOn"
      Effect   = "Deny"
      Action   = "s3:PutAccountPublicAccessBlock"
      Resource = "*"
    },
    {
      # Deleting the analyzer, or archiving what it found.
      Sid    = "AccessAnalyzerStaysOn"
      Effect = "Deny"
      Action = [
        "access-analyzer:DeleteAnalyzer", "access-analyzer:UpdateFindings",
        "access-analyzer:CreateArchiveRule", "access-analyzer:UpdateArchiveRule",
        "access-analyzer:ApplyArchiveRule",
      ]
      Resource = [
        "arn:aws:access-analyzer:${local.region}:${local.account_id}:analyzer/${local.prefix}-external-access",
        "arn:aws:access-analyzer:${local.region}:${local.account_id}:analyzer/${local.prefix}-external-access/*",
      ]
    },
    {
      Sid    = "AlertRulesStayWired"
      Effect = "Deny"
      Action = [
        "events:DeleteRule", "events:DisableRule", "events:PutRule",
        "events:PutTargets", "events:RemoveTargets",
      ]
      Resource = "arn:aws:events:${local.region}:${local.account_id}:rule/${local.prefix}-alert-*"
    },
    {
      # Not sns:Unsubscribe: SNS does not put that call behind IAM, so no
      # policy can hold it. verify.sh checks the email subscription is live.
      Sid      = "AlertTopicStaysPut"
      Effect   = "Deny"
      Action   = ["sns:DeleteTopic", "sns:SetTopicAttributes", "sns:AddPermission", "sns:RemovePermission"]
      Resource = aws_sns_topic.alerts.arn
    },
  ]
}

# --- the ceiling for every role the boardwalk creates ---------------------------
#
# A permissions boundary caps a role no matter what its own policies say:
# effective permissions are the intersection. Without one, "may create roles
# named mwa-*" plus "may attach any policy" plus "may pass the role to Lambda"
# adds up to full administrator, and because this account is the AWS
# Organization's management account, administrator here reaches every member
# account. With it, the most a role created by CI can ever hold is roughly
# what CI itself holds: service APIs in this account, and none of the identity
# machinery.
#
#   allowed   every service API except IAM, Organizations, Account, and STS;
#             IAM reads and policy simulation (plank 8's policy desk);
#             passing plank-prefixed roles (plank 4 hands task roles to ECS)
#   never     creating or editing users, roles, policies, or keys;
#             assuming any role, in this account or another;
#             anything in Organizations or Account;
#             changing the audit trail, its log bucket, the access analyzer,
#             the account public access block, or the alert rules
#             (local.owner_only: an explicit Deny in a boundary binds the
#             role whatever its own policy allows)
#
# This policy and the CI roles are managed only from the owner's machine. A
# change here must be applied locally before it is pushed.

resource "aws_iam_policy" "role_boundary" {
  # Checkov reads this document as if it GRANTED what it lists. It grants
  # nothing: it is attached only as a permissions boundary, never as an
  # identity policy, so it can only take away from what a role's own (narrow,
  # separately scanned) policies allow. The five skips below are scoped to
  # this one resource for that reason; every role policy stays under the gate.
  # checkov:skip=CKV_AWS_286: ceiling, not a grant; and it withholds every IAM write, so PassRole (plank roles only, all under this same boundary) cannot be turned into escalation
  # checkov:skip=CKV_AWS_287: ceiling, not a grant; no role receives credential-reading actions from this document
  # checkov:skip=CKV_AWS_288: ceiling, not a grant; each role's own policy names the buckets and tables it may read
  # checkov:skip=CKV_AWS_289: ceiling, not a grant; IAM, Organizations, Account and STS are excluded outright
  # checkov:skip=CKV_AWS_290: ceiling, not a grant; resource scoping is the job of each role's own policy
  name        = local.role_boundary_name
  description = "Permissions boundary for every role the boardwalk creates: service APIs only, no IAM writes, no Organizations, no role assumption"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "ServicesButNotIdentity"
        Effect    = "Allow"
        NotAction = ["iam:*", "organizations:*", "account:*", "sts:*"]
        Resource  = "*"
      },
      {
        Sid      = "IamReadAndSimulate"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*", "iam:SimulatePrincipalPolicy", "iam:SimulateCustomPolicy"]
        Resource = "*"
      },
      {
        Sid      = "PassOnlyPlankRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.plank_role_arns
      },
    ], local.owner_only)
  })
}

# --- plan role (PRs + main) --------------------------------------------------

resource "aws_iam_role" "gh_plan" {
  name = "${local.prefix}-gh-plan"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = flatten([
            for p in local.github_sub_prefixes : [
              "${p}:pull_request",
              "${p}:ref:refs/heads/main",
            ]
          ])
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "gh_plan_readonly" {
  role       = aws_iam_role.gh_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# terraform plan needs to read state and take/release the S3 lockfile.
resource "aws_iam_role_policy" "gh_plan_state" {
  name = "state-and-secrets"
  role = aws_iam_role.gh_plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StateLock"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.state_bucket}/*.tflock"
      },
      {
        Sid      = "PlankSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/boardwalk/*"
      },
      {
        Sid      = "DecryptSsmSecureString"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "arn:aws:kms:${local.region}:${local.account_id}:key/*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" }
        }
      },
      {
        # ReadOnlyAccess predates some newer Bedrock read actions; refreshing
        # plank 12's guardrail state needs this one.
        Sid      = "BedrockReadTags"
        Effect   = "Allow"
        Action   = ["bedrock:ListTagsForResource"]
        Resource = "arn:aws:bedrock:${local.region}:${local.account_id}:guardrail/*"
      },
    ]
  })
}

# --- apply role (prod environment only) --------------------------------------

resource "aws_iam_role" "gh_apply" {
  name = "${local.prefix}-gh-apply"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Only workflow jobs that passed the repo's "prod" environment
          # protection rules present this subject.
          "token.actions.githubusercontent.com:sub" = [
            for p in local.github_sub_prefixes : "${p}:environment:prod"
          ]
        }
      }
    }]
  })
}

# PowerUserAccess = everything except IAM/org/account management…
resource "aws_iam_role_policy_attachment" "gh_apply_poweruser" {
  role       = aws_iam_role.gh_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# …plus exactly the IAM slice Terraform needs. Two fences, both required:
# names (plank prefixes only) and power (only roles under the boundary).
resource "aws_iam_role_policy" "gh_apply_iam" {
  name = "plank-iam"
  role = aws_iam_role.gh_apply.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Creating a role, or changing what one can do, is allowed only when
        # the role carries the boardwalk boundary. For CreateRole and
        # PutRolePermissionsBoundary the key is the boundary in the request;
        # for the four policy calls it is the boundary already on the role.
        # There is no grant for DeleteRolePermissionsBoundary at all, so a
        # boundary, once on, stays on.
        Sid       = "PlankRolesUnderTheBoundary"
        Effect    = "Allow"
        Action    = local.role_power_actions
        Resource  = local.plank_role_arns
        Condition = { StringEquals = { "iam:PermissionsBoundary" = local.role_boundary_arn } }
      },
      {
        Sid       = "ExhibitRoleUnderItsOwnBoundary"
        Effect    = "Allow"
        Action    = local.role_power_actions
        Resource  = local.exhibit_role_arn
        Condition = { StringEquals = { "iam:PermissionsBoundary" = local.exhibit_boundary_arn } }
      },
      {
        # Housekeeping that cannot widen a role. None of these calls supports
        # the boundary condition key, and none needs it: the trust policy can
        # change who may use a role, never what the role is capped at.
        Sid    = "PlankRoleLifecycle"
        Effect = "Allow"
        Action = [
          "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
          "iam:TagRole", "iam:UntagRole",
          "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
        ]
        Resource = local.plank_role_arns
      },
      {
        Sid    = "PlankPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion",
          "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
          "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions",
        ]
        Resource = local.plank_policy_arns
      },
      {
        # Terraform refreshes the boundary policy on every devops-sre apply.
        Sid      = "ReadRoleBoundary"
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = local.role_boundary_arn
      },
      {
        # A boundary is only a ceiling if the pipeline cannot raise it. The
        # boardwalk boundary is already out of reach by name; plank 8's
        # exhibit boundary sits inside the sec-* namespace, so its content is
        # frozen here. Changing either means a local apply by the owner.
        Sid    = "FrozenBoundaries"
        Effect = "Deny"
        Action = [
          "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
          "iam:SetDefaultPolicyVersion", "iam:DeletePolicy",
        ]
        Resource = [local.role_boundary_arn, local.exhibit_boundary_arn]
      },
      {
        # Instance profiles exist only in plank 9's demo root (the EC2 probe
        # instances). CI never applies demo roots, but the nightly demo-sweep
        # workflow DESTROYS abandoned ones, and that teardown must be able to
        # unwind the profile ↔ role attachment.
        Sid    = "PlankInstanceProfiles"
        Effect = "Allow"
        Action = [
          "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile",
          "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile",
          "iam:GetInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile",
        ]
        Resource = [for p in local.plank_iam_prefixes : "arn:aws:iam::${local.account_id}:instance-profile/${p}"]
      },
      {
        Sid      = "PassPlankRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.plank_role_arns
      },
      {
        Sid      = "ReadOidcProvider"
        Effect   = "Allow"
        Action   = ["iam:GetOpenIDConnectProvider"]
        Resource = aws_iam_openid_connect_provider.github.arn
      },
      {
        # Plank 8's demo root manages AWS Config's service-linked role. The
        # nightly sweep has to refresh it (GetRole) and wait out its deletion
        # before `terraform destroy` can finish; PowerUserAccess already
        # carries Create/DeleteServiceLinkedRole but neither of these reads.
        Sid      = "ReadConfigServiceLinkedRole"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:GetServiceLinkedRoleDeletionStatus"]
        Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/config.amazonaws.com/*"
      },
      {
        # PowerUserAccess allows sts:AssumeRole on anything, and every member
        # account of the Organization has an admin role that trusts this
        # account. Terraform here never assumes a role, so the pipeline may
        # not either: not into a member account, not into anything.
        Sid      = "NeverBecomeAnotherRole"
        Effect   = "Deny"
        Action   = "sts:AssumeRole"
        Resource = "*"
      },
      {
        # prevent_destroy only stops Terraform. This stops the credentials:
        # no boardwalk root, demo roots included, ever deletes a hosted zone,
        # and two of them carry the delegation and the company's mail records.
        # (A future root that creates and removes its own zone would need a
        # narrower statement here.)
        Sid      = "NeverDeleteAHostedZone"
        Effect   = "Deny"
        Action   = "route53:DeleteHostedZone"
        Resource = "*"
      },
      {
        # The CI roles themselves are managed only from the owner's machine —
        # a compromised workflow must not be able to widen its own trust or
        # permissions. Reads stay allowed so terraform can still refresh them.
        Sid    = "NeverSelfModify"
        Effect = "Deny"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary",
          "iam:TagRole", "iam:UntagRole", "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.gh_plan.arn,
          aws_iam_role.gh_apply.arn,
          aws_iam_role.gh_site.arn,
        ]
      },
    ]
  })
}

# PowerUserAccess covers CloudTrail, S3, EventBridge and SNS in full. This
# takes back the account's own record and its tripwires (local.owner_only).
# The pipeline still reads them on every devops-sre apply; a change to any of
# them is the owner's, applied locally before it is pushed.
resource "aws_iam_role_policy" "gh_apply_owner_only" {
  name = "owner-only"
  role = aws_iam_role.gh_apply.id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.owner_only
  })
}

# --- site role (monthly cost refresh + site publish; main branch only) -------
#
# Used by update-costs.yml (Cost Explorer read) and publish-sites.yml
# (s3 sync + CloudFront invalidation for the two site buckets). Deliberately
# narrow, so trusting ref:refs/heads/main is fine here - the concern that
# reverted the single-gate pattern was main-branch trust on PowerUserAccess,
# not on a role that can only read a bill and publish two static sites.
# Like the other CI roles it is in the NeverSelfModify fence above, so
# changes to it must be applied locally before they are pushed.

resource "aws_iam_role" "gh_site" {
  name = "${local.prefix}-gh-site"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            for p in local.github_sub_prefixes : "${p}:ref:refs/heads/main"
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "gh_site" {
  name = "cost-read-and-site-publish"
  role = aws_iam_role.gh_site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Cost Explorer and ListDistributions are not resource-scopable.
        Sid      = "CostRead"
        Effect   = "Allow"
        Action   = ["ce:GetCostAndUsage"]
        Resource = "*"
      },
      {
        Sid      = "FindDistributionsByAlias"
        Effect   = "Allow"
        Action   = ["cloudfront:ListDistributions"]
        Resource = "*"
      },
      {
        Sid      = "InvalidateSites"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "arn:aws:cloudfront::${local.account_id}:distribution/*"
      },
      {
        Sid    = "ListSiteBuckets"
        Effect = "Allow"
        Action = ["s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::www-site-${local.account_id}",
          "arn:aws:s3:::hub-site-${local.account_id}",
        ]
      },
      {
        Sid    = "SyncSiteObjects"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "arn:aws:s3:::www-site-${local.account_id}/*",
          "arn:aws:s3:::hub-site-${local.account_id}/*",
        ]
      },
    ]
  })
}
