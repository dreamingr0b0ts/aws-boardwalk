# The image pipeline: `make image` zips app/ to S3 and starts this CodeBuild
# project, which docker-builds the job image and pushes it to ECR (where
# scan-on-push takes over). There is no Docker on the dev machine at all —
# every image this plank has ever run was built by this pipeline.
# Cost: BUILD_GENERAL1_SMALL is in the always-free tier (100 build-min/month);
# a build takes ~2 minutes.

resource "aws_s3_bucket" "build_src" {
  bucket        = "${local.prefix}-build-${local.account_id}"
  force_destroy = true # demo environment; make destroy must work
}

resource "aws_s3_bucket_public_access_block" "build_src" {
  bucket = aws_s3_bucket.build_src.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${local.prefix}-image-build"
  retention_in_days = 14
}

resource "aws_codebuild_project" "image" {
  name          = "${local.prefix}-image-build"
  description   = "Builds the ctr-app job image from app/ and pushes it to ECR (scan-on-push)"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 15 # minutes; a clean build takes ~2

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = "aws/codebuild/standard:7.0"
    type         = "LINUX_CONTAINER"
    # Required for docker build inside CodeBuild
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URI"
      value = aws_ecr_repository.app.repository_url
    }
  }

  source {
    type     = "S3"
    location = "${aws_s3_bucket.build_src.bucket}/source/app.zip"
    # buildspec.yml rides along at the root of the zip (see ../app/buildspec.yml)
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild.name
    }
  }
}
