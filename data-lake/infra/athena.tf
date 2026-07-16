# Two workgroups because Athena makes enforcement and CTAS mutually
# exclusive: an enforced workgroup rejects any query carrying an
# 'external_location', which is exactly how the ETL's CTAS targets the
# curated zone. So visitor queries run in the ENFORCED workgroup below
# (locked result location + scan cutoff — the cost-governance half of the
# demo), and the ETL runs in its own non-enforced workgroup that only the
# etl role's IAM can reach.

resource "aws_athena_workgroup" "public" {
  name          = "${local.prefix}-public"
  description   = "Colorado business lake — enforced result location + per-query scan cutoff"
  force_destroy = true

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true
    bytes_scanned_cutoff_per_query     = var.bytes_scanned_cutoff

    result_configuration {
      output_location = "s3://${aws_s3_bucket.lake.bucket}/${local.results_prefix}/"

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_athena_workgroup" "etl" {
  # checkov:skip=CKV_AWS_82: CTAS with an external_location is rejected by enforced workgroups; this one is reachable only by the etl role, and the visitor-facing workgroup above IS enforced
  name          = "${local.prefix}-etl"
  description   = "Colorado business lake — CTAS rebuilds; non-enforced so external_location works, IAM-restricted to the etl role"
  force_destroy = true

  configuration {
    enforce_workgroup_configuration    = false
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.lake.bucket}/${local.results_prefix}/"

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}
