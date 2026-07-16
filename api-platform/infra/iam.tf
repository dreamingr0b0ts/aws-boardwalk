# One role per microservice, least privilege per microservice: each service
# Lambda can only touch its own table. The status function gets DescribeTable
# metadata only — it cannot read a single record.

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
  lambda_roles = {
    permits    = aws_iam_role.permits
    licenses   = aws_iam_role.licenses
    facilities = aws_iam_role.facilities
    status     = aws_iam_role.status
  }
}

resource "aws_iam_role" "permits" {
  name               = "${local.prefix}-permits-svc"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "licenses" {
  name               = "${local.prefix}-licenses-svc"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "facilities" {
  name               = "${local.prefix}-facilities-svc"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "status" {
  name               = "${local.prefix}-status-svc"
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

resource "aws_iam_role_policy" "permits_table" {
  name = "own-table-only"
  role = aws_iam_role.permits.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem"]
      Resource = aws_dynamodb_table.permits.arn
    }]
  })
}

resource "aws_iam_role_policy" "licenses_table" {
  name = "own-table-only"
  role = aws_iam_role.licenses.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Scan"]
      Resource = aws_dynamodb_table.licenses.arn
    }]
  })
}

resource "aws_iam_role_policy" "facilities_table" {
  name = "own-table-only"
  role = aws_iam_role.facilities.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Scan"]
      Resource = aws_dynamodb_table.facilities.arn
    }]
  })
}

resource "aws_iam_role_policy" "status_describe" {
  name = "table-metadata-only"
  role = aws_iam_role.status.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["dynamodb:DescribeTable"]
      Resource = [
        aws_dynamodb_table.permits.arn,
        aws_dynamodb_table.licenses.arn,
        aws_dynamodb_table.facilities.arn,
      ]
    }]
  })
}
