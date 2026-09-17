data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  production_env_parameter = "/book-maker/production/env"
}

resource "aws_ecr_repository" "app" {
  for_each             = toset(["app", "web"])
  name                 = "book-maker/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_iam_role" "book_maker" {
  name = "book-maker-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.book_maker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "deployment" {
  name = "book-maker-deployment"
  role = aws_iam_role.book_maker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = [for repository in aws_ecr_repository.app : repository.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.production_env_parameter}"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "book_maker" {
  name = "book-maker"
  role = aws_iam_role.book_maker.name
}

output "instance_id" {
  value = aws_instance.book_maker.id
}

output "app_repository" {
  value = aws_ecr_repository.app["app"].repository_url
}

output "web_repository" {
  value = aws_ecr_repository.app["web"].repository_url
}

output "production_env_parameter" {
  value = local.production_env_parameter
}
