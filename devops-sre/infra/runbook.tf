# Backup/restore drill as an executable runbook (Step Functions):
#   snapshot the permits table → restore into a scratch table → verify the
#   data survived → tear the scratch copy down → publish an RTO/RPO report
#   to the ops status page. Run it with `make drill`.
#
# Everything is on-demand; idle cost is $0.

# --- verify/report Lambda -----------------------------------------------------

data "archive_file" "runbook_verify" {
  type        = "zip"
  output_path = "${path.module}/build/runbook-verify.zip"
  source_file = "${path.module}/../runbook/verify.mjs"
}

resource "aws_iam_role" "runbook_lambda" {
  name = "${local.prefix}-runbook-verify"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "runbook_lambda" {
  name = "verify-and-report"
  role = aws_iam_role.runbook_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CompareTables"
        Effect = "Allow"
        Action = ["dynamodb:Scan", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups"]
        Resource = [
          "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.mwa_table}",
          "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.drill_table_name}",
        ]
      },
      {
        Sid      = "PublishReport"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.site.arn}/runbook/*"
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-*"
      },
      {
        Sid      = "Xray"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "runbook_verify" {
  function_name    = "${local.prefix}-runbook-verify"
  role             = aws_iam_role.runbook_lambda.arn
  runtime          = "nodejs22.x"
  handler          = "verify.handler"
  filename         = data.archive_file.runbook_verify.output_path
  source_code_hash = data.archive_file.runbook_verify.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      SITE_BUCKET  = aws_s3_bucket.site.bucket
      DISTRIBUTION = aws_cloudfront_distribution.site.id
    }
  }

  tracing_config {
    mode = "Active"
  }
}

# After publishing a new report the page should show it immediately.
resource "aws_iam_role_policy" "runbook_lambda_invalidate" {
  name = "invalidate-report-cache"
  role = aws_iam_role.runbook_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudfront:CreateInvalidation"]
      Resource = aws_cloudfront_distribution.site.arn
    }]
  })
}

# --- state machine -------------------------------------------------------------

resource "aws_iam_role" "runbook_sfn" {
  name = "${local.prefix}-runbook-sfn"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "runbook_sfn" {
  name = "drill-steps"
  role = aws_iam_role.runbook_sfn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BackupSource"
        Effect   = "Allow"
        Action   = ["dynamodb:CreateBackup"]
        Resource = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.mwa_table}"
      },
      {
        Sid      = "ManageBackups"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeBackup", "dynamodb:DeleteBackup", "dynamodb:RestoreTableFromBackup"]
        Resource = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.mwa_table}/backup/*"
      },
      {
        Sid    = "DrillTable"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable", "dynamodb:DescribeTable", "dynamodb:DeleteTable",
          "dynamodb:PutItem", "dynamodb:BatchWriteItem", "dynamodb:Scan", "dynamodb:Query",
          "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:DeleteItem",
        ]
        Resource = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.drill_table_name}"
      },
      {
        Sid      = "InvokeVerify"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.runbook_verify.arn
      },
      {
        Sid      = "Xray"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_sfn_state_machine" "runbook" {
  name     = "${local.prefix}-backup-restore-drill"
  role_arn = aws_iam_role.runbook_sfn.arn

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Backup/restore drill: snapshot ${local.mwa_table}, restore to ${var.drill_table_name}, verify, clean up, report RTO/RPO"
    StartAt = "CreateBackup"
    States = {
      CreateBackup = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:createBackup"
        Parameters = {
          TableName      = local.mwa_table
          "BackupName.$" = "States.Format('drill-{}', $$.Execution.Name)"
        }
        ResultPath = "$.backup"
        Next       = "WaitForBackup"
      }
      WaitForBackup = {
        Type    = "Wait"
        Seconds = 10
        Next    = "CheckBackup"
      }
      CheckBackup = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:describeBackup"
        Parameters = {
          "BackupArn.$" = "$.backup.BackupDetails.BackupArn"
        }
        ResultPath = "$.backupCheck"
        Next       = "BackupReady?"
      }
      "BackupReady?" = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.backupCheck.BackupDescription.BackupDetails.BackupStatus"
          StringEquals = "AVAILABLE"
          Next         = "RestoreTable"
        }]
        Default = "WaitForBackup"
      }
      RestoreTable = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:restoreTableFromBackup"
        Parameters = {
          TargetTableName = var.drill_table_name
          "BackupArn.$"   = "$.backup.BackupDetails.BackupArn"
        }
        ResultPath = "$.restore"
        Next       = "WaitForRestore"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "CleanupBackupAfterFailure"
        }]
      }
      WaitForRestore = {
        Type    = "Wait"
        Seconds = 20
        Next    = "CheckRestore"
      }
      CheckRestore = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:describeTable"
        Parameters = {
          TableName = var.drill_table_name
        }
        ResultPath = "$.tableCheck"
        Next       = "RestoreReady?"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "CleanupDrillTable"
        }]
      }
      "RestoreReady?" = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.tableCheck.Table.TableStatus"
          StringEquals = "ACTIVE"
          Next         = "VerifyAndReport"
        }]
        Default = "WaitForRestore"
      }
      VerifyAndReport = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.runbook_verify.function_name
          Payload = {
            sourceTable         = local.mwa_table
            drillTable          = var.drill_table_name
            "backupArn.$"       = "$.backup.BackupDetails.BackupArn"
            "backupCreatedAt.$" = "$.backup.BackupDetails.BackupCreationDateTime"
            "executionStart.$"  = "$$.Execution.StartTime"
            "executionName.$"   = "$$.Execution.Name"
          }
        }
        ResultSelector = { "report.$" = "$.Payload" }
        ResultPath     = "$.verify"
        Next           = "CleanupDrillTable"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "CleanupDrillTable"
        }]
      }
      CleanupDrillTable = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:deleteTable"
        Parameters = {
          TableName = var.drill_table_name
        }
        ResultPath = null
        Next       = "CleanupBackup"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.cleanupError"
          Next        = "CleanupBackup"
        }]
      }
      CleanupBackup = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:deleteBackup"
        Parameters = {
          "BackupArn.$" = "$.backup.BackupDetails.BackupArn"
        }
        ResultPath = null
        Next       = "DrillSucceeded?"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.cleanupError"
          Next        = "DrillSucceeded?"
        }]
      }
      CleanupBackupAfterFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:dynamodb:deleteBackup"
        Parameters = {
          "BackupArn.$" = "$.backup.BackupDetails.BackupArn"
        }
        ResultPath = null
        Next       = "DrillFailed"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.cleanupError"
          Next        = "DrillFailed"
        }]
      }
      "DrillSucceeded?" = {
        Type = "Choice"
        Choices = [{
          Variable  = "$.error"
          IsPresent = true
          Next      = "DrillFailed"
        }]
        Default = "DrillSucceeded"
      }
      DrillSucceeded = {
        Type = "Succeed"
      }
      DrillFailed = {
        Type  = "Fail"
        Error = "DrillFailed"
        Cause = "The backup/restore drill did not complete cleanly — see execution history"
      }
    }
  })
}
