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

# Keep the registry from accumulating build history (storage is the only ECR
# idle cost). Two tag families now share the repo — slim builds (latest + b<n>)
# and the deliberately heavy exhibit builds (fat + fat-b<n>) — so each family
# gets its own keep-5 rule; the tagStatus=any backstop catches strays.
resource "aws_ecr_lifecycle_policy" "keep_last_5" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "keep the 5 most recent fat builds"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["fat"]
          countType     = "imageCountMoreThan"
          countNumber   = 5
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "keep the 5 most recent slim builds"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["b", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 5
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "backstop: never hold more than 12 images total"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 12
        }
        action = { type = "expire" }
      },
    ]
  })
}
