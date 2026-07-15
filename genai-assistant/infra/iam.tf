# One role per function, least privilege per function. Only the chat Lambda can
# invoke the answer model; only ingest can write the index; the public Lambda
# can read exactly one metadata object and touches no AI at all.

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
  titan_arn = "arn:aws:bedrock:${local.region}::foundation-model/${var.embed_model_id}"

  lambda_roles = {
    public = aws_iam_role.public
    chat   = aws_iam_role.chat
    ingest = aws_iam_role.ingest
  }
}

resource "aws_iam_role" "public" {
  name               = "${local.prefix}-public-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "chat" {
  name               = "${local.prefix}-chat-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ingest" {
  name               = "${local.prefix}-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic_logs" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "public_s3" {
  name = "read-index-meta-only"
  role = aws_iam_role.public.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.corpus.arn}/index/meta.json"
    }]
  })
}

resource "aws_iam_role_policy" "chat_all" {
  name = "chat-rag-and-guardrails"
  role = aws_iam_role.chat.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RateLimitCountersAndLogs"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.assistant.arn
      },
      {
        Sid      = "ReadEmbeddingIndex"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.corpus.arn}/index/*"
      },
      {
        Sid      = "InvokeAnswerModel"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = concat(local.haiku_arns, [local.titan_arn])
      },
    ]
  })
}

resource "aws_iam_role_policy" "ingest_all" {
  name = "embed-corpus-write-index"
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.corpus.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.corpus.arn}/corpus/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.corpus.arn}/index/*"
      },
      {
        Sid      = "EmbeddingsOnlyNoAnswerModel"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = local.titan_arn
      },
    ]
  })
}
