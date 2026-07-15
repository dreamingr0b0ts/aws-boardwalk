# The IDP pipeline, one visible state per stage of the story:
#   register/validate → Textract FORMS (async, polled) → Comprehend entities
#   → Bedrock classification → index. Any failure lands in MarkFailed — a
#   direct DynamoDB integration (no Lambda) that flips the record to FAILED so
#   the UI never shows a document stuck in PROCESSING.
#
# Retries are limited to Lambda *service* errors on purpose: retrying an
# application error in RegisterAndStartOcr could start (and pay for) a second
# Textract job.

locals {
  lambda_retry = [{
    ErrorEquals = [
      "Lambda.ServiceException",
      "Lambda.TooManyRequestsException",
      "Lambda.AWSLambdaException",
      "Lambda.SdkClientException",
    ]
    IntervalSeconds = 2
    MaxAttempts     = 3
    BackoffRate     = 2
  }]

  catch_to_failed = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkFailed"
  }]
}

resource "aws_sfn_state_machine" "pipeline" {
  name     = "${local.prefix}-pipeline"
  role_arn = aws_iam_role.pipeline.arn

  tracing_configuration {
    enabled = true # X-Ray, consistent with every Lambda in the boardwalk
  }

  definition = jsonencode({
    Comment        = "Intelligent document processing: OCR -> entities -> classify -> index"
    StartAt        = "RegisterAndStartOcr"
    TimeoutSeconds = 600

    States = {
      RegisterAndStartOcr = {
        Type     = "Task"
        Resource = aws_lambda_function.ocr.arn
        Parameters = {
          step       = "start"
          "bucket.$" = "$.detail.bucket.name"
          "key.$"    = "$.detail.object.key"
        }
        Retry = local.lambda_retry
        Catch = local.catch_to_failed
        Next  = "WasAccepted"
      }

      WasAccepted = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.rejected"
          BooleanEquals = true
          Next          = "Rejected"
        }]
        Default = "WaitForOcr"
      }

      # Validation rejections are a normal, successful outcome for the
      # pipeline (the record is marked REJECTED with a reason; no OCR ran).
      Rejected = { Type = "Succeed" }

      WaitForOcr = {
        Type    = "Wait"
        Seconds = 4
        Next    = "PollOcr"
      }

      PollOcr = {
        Type     = "Task"
        Resource = aws_lambda_function.ocr.arn
        Parameters = {
          step          = "poll"
          "docId.$"     = "$.docId"
          "jobId.$"     = "$.jobId"
          "pollCount.$" = "$.pollCount"
        }
        Retry = local.lambda_retry
        Catch = local.catch_to_failed
        Next  = "OcrDone"
      }

      OcrDone = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.done"
          BooleanEquals = false
          Next          = "WaitForOcr"
        }]
        Default = "DetectEntities"
      }

      DetectEntities = {
        Type     = "Task"
        Resource = aws_lambda_function.enrich.arn
        Parameters = {
          step      = "entities"
          "docId.$" = "$.docId"
        }
        Retry = local.lambda_retry
        Catch = local.catch_to_failed
        Next  = "ClassifyDocument"
      }

      ClassifyDocument = {
        Type     = "Task"
        Resource = aws_lambda_function.enrich.arn
        Parameters = {
          step      = "classify"
          "docId.$" = "$.docId"
        }
        Retry = local.lambda_retry
        Catch = local.catch_to_failed
        Next  = "IndexDocument"
      }

      IndexDocument = {
        Type     = "Task"
        Resource = aws_lambda_function.enrich.arn
        Parameters = {
          step      = "index"
          "docId.$" = "$.docId"
        }
        Retry = local.lambda_retry
        Catch = local.catch_to_failed
        End   = true
      }

      # The docId is recovered from the execution's original S3 event, so this
      # works no matter which state failed (even before the record existed).
      MarkFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.documents.name
          Key = {
            PK = { "S.$" = "States.Format('DOC#{}', States.ArrayGetItem(States.StringSplit($$.Execution.Input.detail.object.key, '/'), 1))" }
            SK = { S = "META" }
          }
          UpdateExpression         = "SET #s = :failed, #e = :err"
          ExpressionAttributeNames = { "#s" = "status", "#e" = "error" }
          ExpressionAttributeValues = {
            ":failed" = { S = "FAILED" }
            ":err"    = { "S.$" = "$.error.Cause" }
          }
        }
        Next = "PipelineFailed"
      }

      PipelineFailed = {
        Type  = "Fail"
        Error = "PipelineFailed"
        Cause = "A pipeline stage failed; the document record has the detail."
      }
    }
  })
}
