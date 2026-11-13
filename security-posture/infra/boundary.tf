# The permissions-boundary exhibit. The role's identity policy grants read AND
# write on the site bucket, but its boundary only ceilings read: effective
# permissions are the INTERSECTION, so the write is implicitly denied even
# though a policy grants it. The evidence report and the live policy desk both
# prove it with iam:SimulatePrincipalPolicy rather than assertion.
#
# This lived in the demo root until 2026-07: IAM bills nothing, and moving it
# always-on is what lets the policy desk answer between demo windows. The four
# curated simulations cover the whole intersection matrix:
#   s3:GetObject   in policy, in boundary   → allowed
#   s3:PutObject   in policy, NOT boundary  → implicitDeny
#   s3:ListBucket  in boundary, NOT policy  → implicitDeny
#   iam:CreateUser in neither               → implicitDeny
#
# Every other boardwalk role carries the shared boardwalk-role-boundary; this
# one keeps its own, tighter ceiling because the ceiling IS the exhibit. For
# that to be safe, the CI apply role is denied any write to this policy
# (FrozenBoundaries in devops-sre/infra/github-oidc.tf): a pipeline that could
# edit a boundary could raise it. So a change to the policy below must be
# applied from the owner's machine before it is pushed, like the CI roles.

resource "aws_iam_policy" "boundary" {
  name        = "${local.prefix}-permission-boundary"
  description = "Boundary ceiling for Alpenglow demo workloads: S3 reads + own logs, nothing else"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CeilingS3Read"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.site.arn,
          "${aws_s3_bucket.site.arn}/*",
        ]
      },
      {
        Sid      = "CeilingOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/demo/*"
      }
    ]
  })
}

resource "aws_iam_role" "boundary_demo" {
  name                 = "${local.prefix}-boundary-demo"
  permissions_boundary = aws_iam_policy.boundary.arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Deliberately over-permissive relative to the boundary: PutObject is granted
# here but outside the ceiling, so it must simulate to implicitDeny.
resource "aws_iam_role_policy" "boundary_demo" {
  name = "app-policy"
  role = aws_iam_role.boundary_demo.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AppS3ReadWrite"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "${aws_s3_bucket.site.arn}/*"
    }]
  })
}
