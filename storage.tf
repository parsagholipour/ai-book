# Independent of the EC2 root disk: generated files survive instance replacement.
resource "aws_s3_bucket" "assets" {
  bucket = "book-maker-assets-${data.aws_caller_identity.current.account_id}-${data.aws_region.current.name}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RequireTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Books are kept forever, and one bad prefix delete (`deletePrefix` takes a
# whole book) used to lose them for good. With versioning, a delete or an
# overwrite leaves the old bytes as a noncurrent version that the lifecycle
# below removes 30 days later: recoverable for a month, and still gone after
# it, which is what account and book deletion promise. A bucket that has had
# versioning on can only be suspended, never returned to unversioned.
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  # Noncurrent-version rules on a bucket whose versioning is not yet applied
  # would be accepted and do nothing.
  depends_on = [aws_s3_bucket_versioning.assets]

  rule {
    id     = "abort-unfinished-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Deleted and overwritten objects: 30 days, then gone. Recompiles overwrite
  # a book's exports, so a heavily edited book carries up to a month of old
  # PDFs here; at launch volume that is cents. The delete markers left once
  # their last version expires are removed too.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    expiration {
      expired_object_delete_marker = true
    }
  }

  # The database dump scripts/deploy-production.sh takes before every
  # migration (docs/deployment.md, "Restoring the database before a release").
  # It holds every account, so it lives 30 days and its expired version one
  # more; where two rules overlap, S3 applies the shorter expiry.
  rule {
    id     = "expire-database-dumps"
    status = "Enabled"
    filter {
      prefix = "db-backups/"
    }
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

resource "aws_iam_role_policy" "assets" {
  name = "book-maker-assets"
  role = aws_iam_role.book_maker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.assets.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
        Resource = "${aws_s3_bucket.assets.arn}/*"
      }
    ]
  })
}

output "assets_bucket" {
  value = aws_s3_bucket.assets.id
}
