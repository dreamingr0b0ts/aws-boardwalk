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
  plank_iam_prefixes = ["mwa-*", "gai-*", "hub-*", "idp-*", "ops-*", "platform-*"]
  plank_role_arns    = [for p in local.plank_iam_prefixes : "arn:aws:iam::${local.account_id}:role/${p}"]
  plank_policy_arns  = [for p in local.plank_iam_prefixes : "arn:aws:iam::${local.account_id}:policy/${p}"]
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

# …plus exactly the IAM slice Terraform needs, fenced to plank-prefixed names.
resource "aws_iam_role_policy" "gh_apply_iam" {
  name = "plank-iam"
  role = aws_iam_role.gh_apply.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PlankRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy",
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
        # The CI roles themselves are managed only from the owner's machine —
        # a compromised workflow must not be able to widen its own trust or
        # permissions. Reads stay allowed so terraform can still refresh them.
        Sid    = "NeverSelfModify"
        Effect = "Deny"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy",
          "iam:TagRole", "iam:UntagRole", "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.gh_plan.arn,
          aws_iam_role.gh_apply.arn,
        ]
      },
    ]
  })
}
