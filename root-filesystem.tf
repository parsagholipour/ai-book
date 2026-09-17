# An EBS resize alone leaves an existing AMI partition/filesystem unchanged.
# Replace only the association when its inputs change: provider v5 waits for
# success on association creation, but not on an in-place association update.
resource "terraform_data" "root_filesystem" {
  triggers_replace = {
    instance_id      = aws_instance.book_maker.id
    root_volume_size = var.root_volume_size
    script_sha256    = filesha256("${path.module}/scripts/prepare-production-disk.sh")
  }
}

resource "aws_ssm_association" "root_filesystem" {
  name                             = "AWS-RunShellScript"
  association_name                 = "book-maker-root-filesystem"
  wait_for_success_timeout_seconds = 600

  targets {
    key    = "InstanceIds"
    values = [aws_instance.book_maker.id]
  }

  parameters = {
    commands         = "bash -s <<'BOOK_MAKER_ROOT_DISK'\n${file("${path.module}/scripts/prepare-production-disk.sh")}\nBOOK_MAKER_ROOT_DISK"
    executionTimeout = "300"
  }

  depends_on = [
    aws_iam_role_policy_attachment.ssm,
    aws_route_table_association.book_maker,
    aws_eip_association.book_maker,
  ]

  lifecycle {
    replace_triggered_by = [terraform_data.root_filesystem]
  }
}
