# The image registry half of the exhibit: CodeBuild pushes here, ECR basic
# scanning (free) runs on every push, and the dashboard reads the findings
# back out via the API.

resource "aws_ecr_repository" "app" {
  name         = "${local.prefix}-app"
  force_delete = true # demo environment; make destroy must work

  # MUTABLE on purpose: the demo task definition tracks :latest so an image
  # rebuild never requires a task-definition revision. Production would pin
  # immutable tags or digests — the README calls this out.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep the registry from accumulating build history: the newest 5 images
# stay, everything older is expired (storage is the only ECR idle cost).
resource "aws_ecr_lifecycle_policy" "keep_last_5" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the 5 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
