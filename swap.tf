# The swapfile the memory budget in docker-compose.production.yml counts on
# (docs/deployment.md, "Memory budget and swap"). Without it, one burst past
# physical memory goes to the kernel OOM killer, or thrashes until SSM stops
# answering while EC2 status checks still pass.
#
# Same shape as root-filesystem.tf: the association is replaced, never updated,
# because provider v5 waits for success only on creation. The script is safe to
# rerun and never switches off or rewrites an active swapfile, so replacing the
# association when the script changes costs nothing on a host that has one. An
# instance-type change stops and starts the same instance, keeping its root
# volume and the fstab entry, so it does not need a rerun.
resource "terraform_data" "swap" {
  triggers_replace = {
    instance_id   = aws_instance.book_maker.id
    script_sha256 = filesha256("${path.module}/scripts/prepare-production-swap.sh")
  }
}

resource "aws_ssm_association" "swap" {
  name                             = "AWS-RunShellScript"
  association_name                 = "book-maker-swap"
  wait_for_success_timeout_seconds = 600

  targets {
    key    = "InstanceIds"
    values = [aws_instance.book_maker.id]
  }

  parameters = {
    commands         = "bash -s <<'BOOK_MAKER_SWAP'\n${file("${path.module}/scripts/prepare-production-swap.sh")}\nBOOK_MAKER_SWAP"
    executionTimeout = "300"
  }

  # The swapfile takes 2 GiB of the root filesystem, so it waits for that
  # filesystem to be grown to the whole volume first.
  depends_on = [aws_ssm_association.root_filesystem]

  lifecycle {
    replace_triggered_by = [terraform_data.swap]
  }
}
