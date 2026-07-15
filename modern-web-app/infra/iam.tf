# One role per function, least privilege per function. The RBAC story runs
# through every layer: the public Lambda physically cannot write, the citizen
# Lambda cannot delete, only the demo-reset Lambda can scan or touch Cognito.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  table_arns = [
    aws_dynamodb_table.permits.arn,
    "${aws_dynamodb_table.permits.arn}/index/*",
  ]
  lambda_roles = {
    public      = aws_iam_role.public
    me          = aws_iam_role.me
    admin       = aws_iam_role.admin
    demo        = aws_iam_role.demo
    postconfirm = aws_iam_role.postconfirm
  }
}

resource "aws_iam_role" "public" {
  name               = "${local.prefix}-public-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "me" {
  name               = "${local.prefix}-me-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "admin" {
  name               = "${local.prefix}-admin-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "demo" {
  name               = "${local.prefix}-demo-reset"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "postconfirm" {
  name               = "${local.prefix}-postconfirm"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic_logs" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# X-Ray tracing (plank 10 wires the observability side)
resource "aws_iam_role_policy_attachment" "xray_write" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "public_ddb" {
  name = "ddb-read-only"
  role = aws_iam_role.public.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"]
      Resource = local.table_arns
    }]
  })
}

resource "aws_iam_role_policy" "me_ddb" {
  name = "ddb-own-applications"
  role = aws_iam_role.me.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:Query",
        "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:ConditionCheckItem",
      ]
      Resource = local.table_arns
    }]
  })
}

resource "aws_iam_role_policy" "admin_ddb" {
  name = "ddb-review-and-catalog"
  role = aws_iam_role.admin.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:Query",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
        "dynamodb:ConditionCheckItem",
      ]
      Resource = local.table_arns
    }]
  })
}

resource "aws_iam_role_policy" "demo_ddb_cognito" {
  name = "reset-demo-environment"
  role = aws_iam_role.demo.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:*"]
        Resource = local.table_arns
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminDeleteUser",
        ]
        Resource = aws_cognito_user_pool.users.arn
      },
    ]
  })
}
