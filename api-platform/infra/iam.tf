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
    permits        = aws_iam_role.permits
    licenses       = aws_iam_role.licenses
    facilities     = aws_iam_role.facilities
    status         = aws_iam_role.status
    platform       = aws_iam_role.platform
    exports_api    = aws_iam_role.exports_api
    exports_worker = aws_iam_role.exports_worker
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

resource "aws_iam_role" "platform" {
  name               = "${local.prefix}-platform-svc"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "exports_api" {
  name               = "${local.prefix}-exports-svc"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "exports_worker" {
  name               = "${local.prefix}-exports-worker"
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
        aws_dynamodb_table.exports.arn,
      ]
    }]
  })
}

# The platform service is the only role in the plank allowed near the API
# Gateway control plane, and only these paths: list plans/keys to resolve
# names, read the demo plan's meter, mint keys onto the visitor plan, and
# delete keys for the nightly sweep (code further restricts deletion to the
# apx-visitor- name prefix).
resource "aws_iam_role_policy" "platform_control_plane" {
  name = "usage-plans-and-visitor-keys"
  role = aws_iam_role.platform.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["apigateway:GET"]
        Resource = [
          "arn:aws:apigateway:${local.region}::/usageplans",
          "arn:aws:apigateway:${local.region}::/usageplans/*/usage",
          "arn:aws:apigateway:${local.region}::/apikeys",
        ]
      },
      {
        Effect = "Allow"
        Action = ["apigateway:POST"]
        Resource = [
          "arn:aws:apigateway:${local.region}::/apikeys",
          "arn:aws:apigateway:${local.region}::/usageplans/${aws_api_gateway_usage_plan.visitor.id}/keys",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["apigateway:DELETE"]
        Resource = "arn:aws:apigateway:${local.region}::/apikeys/*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "platform_table" {
  name = "own-table-only"
  role = aws_iam_role.platform.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
      Resource = aws_dynamodb_table.platform.arn
    }]
  })
}

resource "aws_iam_role_policy" "exports_api" {
  name = "jobs-queue-and-presign"
  role = aws_iam_role.exports_api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.exports.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.export_jobs.arn
      },
      {
        # GetObject so presigned download URLs sign against this role.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.exports.arn}/exports/*"
      },
    ]
  })
}

# The worker is the one role that reads across the catalog tables — read-only,
# so the "each service owns its table" write boundary stays intact.
resource "aws_iam_role_policy" "exports_worker" {
  name = "read-catalogs-write-artifacts"
  role = aws_iam_role.exports_worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["dynamodb:Scan"]
        Resource = [
          aws_dynamodb_table.permits.arn,
          aws_dynamodb_table.licenses.arn,
          aws_dynamodb_table.facilities.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.exports.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.exports.arn}/exports/*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.export_jobs.arn
      },
    ]
  })
}
