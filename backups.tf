# Daily snapshots of the instance's disks.
#
# Postgres — accounts, the credit ledger, purchases and every book's rows — lives
# in a Docker volume on the single root disk of the one instance (main.tf), and
# nothing backed it up: losing the disk or the instance lost the business. Data
# Lifecycle Manager snapshots every volume of the instance tagged below once a
# day and keeps two weeks of them. A snapshot of a running Postgres is
# crash-consistent, which Postgres recovers from by replaying its write-ahead
# log, the same as after a power cut. Book files live in S3 (storage.tf) and
# are not on this disk.
#
# Restore: create a volume from the snapshot in the instance's availability
# zone, stop the instance, swap the root volume (or attach it and copy the
# Docker volume back), start it. Rehearse this once before launch.

resource "aws_iam_role" "dlm" {
  name = "book-maker-dlm"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily_snapshots" {
  description        = "book-maker daily instance snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["INSTANCE"]

    target_tags = {
      Name = "book-maker"
    }

    schedule {
      name = "daily"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }

      retain_rule {
        count = 14
      }

      tags_to_add = {
        SnapshotCreator = "dlm-book-maker"
      }

      copy_tags = true
    }
  }
}
