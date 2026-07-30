# The exports job queue — the seam between the 202-Accepted API half and the
# worker half of the exports service. Free tier covers it many times over.

resource "aws_sqs_queue" "export_jobs" {
  name                       = "${local.prefix}-export-jobs"
  message_retention_seconds  = 3600 # a job unprocessed for an hour is dead anyway; the record TTLs
  visibility_timeout_seconds = 180  # 6x the worker's 30s timeout
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.export_jobs_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "export_jobs_dlq" {
  name                      = "${local.prefix}-export-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to notice a poisoned job
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_event_source_mapping" "export_worker" {
  event_source_arn = aws_sqs_queue.export_jobs.arn
  function_name    = aws_lambda_function.exports_worker.arn
  batch_size       = 1 # jobs are few and independent; no partial-batch bookkeeping
}
