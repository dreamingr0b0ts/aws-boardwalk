data "archive_file" "contact" {
  type        = "zip"
  source_file = "${path.module}/../backend/contact.mjs"
  output_path = "${path.module}/build/contact.zip"
}

resource "aws_cloudwatch_log_group" "contact" {
  name              = "/aws/lambda/${local.prefix}-contact"
  retention_in_days = 30
}

resource "aws_iam_role" "contact" {
  name = "${local.prefix}-contact-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "contact" {
  name = "contact"
  role = aws_iam_role.contact.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.contact.arn}:*"
      },
      {
        Sid      = "RateCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.rate_limit.arn
      },
      {
        Sid    = "SendMail"
        Effect = "Allow"
        Action = ["ses:SendEmail"]
        Resource = [
          aws_sesv2_email_identity.contact.arn,
          aws_sesv2_email_identity.domain.arn,
        ]
      },
    ]
  })
}

# X-Ray tracing (plank 10 wires the observability side)
resource "aws_iam_role_policy_attachment" "xray_write" {
  role       = aws_iam_role.contact.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_lambda_function" "contact" {
  function_name    = "${local.prefix}-contact"
  role             = aws_iam_role.contact.arn
  runtime          = "nodejs22.x"
  handler          = "contact.handler"
  filename         = data.archive_file.contact.output_path
  source_code_hash = data.archive_file.contact.output_base64sha256
  timeout          = 10
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      TABLE_NAME     = aws_dynamodb_table.rate_limit.name
      CONTACT_EMAIL  = var.contact_email
      DAILY_IP_LIMIT = "10"
      DAILY_LIMIT    = "100"
    }
  }

  depends_on = [aws_cloudwatch_log_group.contact]
}
