# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["api", "etl"]

  lambda_env = {
    LAKE_BUCKET        = aws_s3_bucket.lake.bucket
    GLUE_DB            = aws_glue_catalog_database.lake.name
    RAW_TABLE          = local.raw_table
    CURATED_TABLE      = local.curated_table
    RAW_PREFIX         = local.raw_prefix
    CURATED_PREFIX     = local.curated_prefix
    ANALYTICS_PREFIX   = local.analytics_prefix
    WORKGROUP          = aws_athena_workgroup.public.name
    TABLE_NAME         = aws_dynamodb_table.app.name
    GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    CACHE_TTL_HOURS    = tostring(var.query_cache_ttl_hours)
  }
}

data "archive_file" "handler" {
  for_each    = toset(local.handlers)
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.prefix}-api"
  role             = aws_iam_role.api.arn
  filename         = data.archive_file.handler["api"].output_path
  source_code_hash = data.archive_file.handler["api"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 28 # under API Gateway's 30s ceiling; catalog queries run in 1–10s

  environment {
    variables = local.lambda_env
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

# The ETL: drop + rebuild the curated Parquet table via CTAS (in its own
# non-enforced workgroup — see athena.tf), then precompute the dashboard
# aggregates into the analytics zone. Invoked by `make etl` after an ingest —
# there's no schedule because the snapshot is deliberately static between
# refreshes.
resource "aws_lambda_function" "etl" {
  function_name    = "${local.prefix}-etl"
  role             = aws_iam_role.etl.arn
  filename         = data.archive_file.handler["etl"].output_path
  source_code_hash = data.archive_file.handler["etl"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 900

  environment {
    variables = merge(local.lambda_env, { WORKGROUP = aws_athena_workgroup.etl.name })
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
