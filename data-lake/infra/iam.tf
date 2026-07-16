# One role per function. Athena runs S3 and Glue calls with the CALLER's
# credentials, so each role spells out exactly which zones of the lake its
# queries may touch: the api can read but never write data; only the etl can
# rebuild the curated zone or touch the catalog's curated table.

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
    api = aws_iam_role.api
    etl = aws_iam_role.etl
  }

  glue_catalog_arn = "arn:aws:glue:${local.region}:${local.account_id}:catalog"
  glue_db_arn      = "arn:aws:glue:${local.region}:${local.account_id}:database/${local.glue_db}"
  glue_tables_arn  = "arn:aws:glue:${local.region}:${local.account_id}:table/${local.glue_db}/*"
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "etl" {
  name               = "${local.prefix}-etl"
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
  name = "run-catalog-queries-read-lake"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunQueriesInWorkgroup"
        Effect   = "Allow"
        Action   = ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"]
        Resource = aws_athena_workgroup.public.arn
      },
      {
        Sid      = "PlanAgainstCatalog"
        Effect   = "Allow"
        Action   = ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartition", "glue:GetPartitions"]
        Resource = [local.glue_catalog_arn, local.glue_db_arn, local.glue_tables_arn]
      },
      {
        Sid      = "ListLake"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.lake.arn
      },
      {
        Sid    = "ReadDataZones"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.lake.arn}/${local.raw_prefix}/*",
          "${aws_s3_bucket.lake.arn}/${local.curated_prefix}/*",
          "${aws_s3_bucket.lake.arn}/${local.analytics_prefix}/*",
        ]
      },
      {
        # Athena writes query output here on the api's behalf, then the api
        # reads it back once to build the response.
        Sid      = "QueryResultsScratch"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.lake.arn}/${local.results_prefix}/*"
      },
      {
        Sid      = "CacheAndCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.app.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "etl_all" {
  name = "rebuild-curated-zone"
  role = aws_iam_role.etl.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunQueriesInEtlWorkgroup"
        Effect   = "Allow"
        Action   = ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"]
        Resource = aws_athena_workgroup.etl.arn
      },
      {
        # CTAS registers the curated table + its partitions in the catalog.
        Sid    = "ManageCuratedCatalogEntry"
        Effect = "Allow"
        Action = [
          "glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartition", "glue:GetPartitions",
          "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable",
          "glue:CreatePartition", "glue:BatchCreatePartition", "glue:DeletePartition", "glue:BatchDeletePartition",
        ]
        Resource = [local.glue_catalog_arn, local.glue_db_arn, local.glue_tables_arn]
      },
      {
        Sid      = "ListLake"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.lake.arn
      },
      {
        Sid      = "ReadRaw"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.lake.arn}/${local.raw_prefix}/*"
      },
      {
        # Rebuilds start clean: delete the old Parquet, let CTAS write the new.
        Sid    = "RebuildCuratedAndAnalytics"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "${aws_s3_bucket.lake.arn}/${local.curated_prefix}/*",
          "${aws_s3_bucket.lake.arn}/${local.analytics_prefix}/*",
        ]
      },
      {
        Sid      = "QueryResultsScratch"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.lake.arn}/${local.results_prefix}/*"
      },
    ]
  })
}
