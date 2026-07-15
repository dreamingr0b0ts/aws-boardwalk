# One role per function, least privilege per function: only ocr can start
# Textract jobs, only enrich can call Comprehend/Bedrock, the api role touches
# no AI service at all, and reset is the only deleter.

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
  # Cross-region inference profile: permission is needed on the profile itself
  # AND the underlying foundation model in every region the profile can route to.
  haiku_arns = [
    "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${var.model_id}",
    "arn:aws:bedrock:*::foundation-model/${replace(var.model_id, "us.", "")}",
  ]

  lambda_roles = {
    api    = aws_iam_role.api
    ocr    = aws_iam_role.ocr
    enrich = aws_iam_role.enrich
    reset  = aws_iam_role.reset
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ocr" {
  name               = "${local.prefix}-ocr"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "enrich" {
  name               = "${local.prefix}-enrich"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "reset" {
  name               = "${local.prefix}-reset"
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

resource "aws_iam_role_policy" "api_all" {
  name = "index-reads-and-presign"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "IndexReadsAndRateCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.documents.arn
      },
      {
        # Backs the presigned POST (upload) and presigned GET (view original).
        # The Lambda never streams document bytes itself.
        Sid      = "PresignUploadsAndOriginals"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.docs.arn}/incoming/*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "ocr_all" {
  name = "textract-and-extraction"
  role = aws_iam_role.ocr.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read the original (page-count guard + Textract reads via the caller)
        Sid      = "ReadIncoming"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.docs.arn}/incoming/*"
      },
      {
        Sid      = "WriteExtraction"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.docs.arn}/extracted/*"
      },
      {
        # Textract has no resource-level permissions
        Sid      = "AsyncFormsAnalysis"
        Effect   = "Allow"
        Action   = ["textract:StartDocumentAnalysis", "textract:GetDocumentAnalysis"]
        Resource = "*"
      },
      {
        Sid      = "DocumentRecord"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.documents.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "enrich_all" {
  name = "comprehend-bedrock-index"
  role = aws_iam_role.enrich.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadExtraction"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.docs.arn}/extracted/*"
      },
      {
        # Comprehend has no resource-level permissions for detection APIs
        Sid      = "EntityAndPiiDetection"
        Effect   = "Allow"
        Action   = ["comprehend:DetectEntities", "comprehend:ContainsPiiEntities"]
        Resource = "*"
      },
      {
        Sid      = "InvokeClassifierModel"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = local.haiku_arns
      },
      {
        Sid      = "DocumentRecord"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.documents.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "reset_all" {
  name = "purge-uploaded-docs"
  role = aws_iam_role.reset.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "FindAndDeleteUploadRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.documents.arn
      },
      {
        Sid      = "ListDocObjects"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.docs.arn
      },
      {
        Sid      = "DeleteDocObjects"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.docs.arn}/incoming/*", "${aws_s3_bucket.docs.arn}/extracted/*"]
      },
    ]
  })
}

# --- Step Functions pipeline role -------------------------------------------

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pipeline" {
  name               = "${local.prefix}-pipeline"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "pipeline_all" {
  name = "invoke-steps-and-mark-failed"
  role = aws_iam_role.pipeline.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokePipelineSteps"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [aws_lambda_function.ocr.arn, aws_lambda_function.enrich.arn]
      },
      {
        # MarkFailed is a direct DynamoDB integration — no Lambda involved
        Sid      = "MarkFailed"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.documents.arn
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "pipeline_xray" {
  role       = aws_iam_role.pipeline.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# --- EventBridge → Step Functions role ---------------------------------------

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name               = "${local.prefix}-events"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

resource "aws_iam_role_policy" "events_start_pipeline" {
  name = "start-pipeline"
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = aws_sfn_state_machine.pipeline.arn
    }]
  })
}
