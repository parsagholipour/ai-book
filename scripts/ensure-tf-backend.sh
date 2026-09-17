#!/usr/bin/env bash
# Creates the S3 bucket that holds Terraform state. Must match the backend
# block in main.tf. Safe to run repeatedly.
set -euo pipefail

BUCKET="${TF_STATE_BUCKET:-parsagholipour-ai-book-tfstate}"
REGION="${AWS_REGION:-eu-central-1}"

if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "Terraform state bucket $BUCKET already exists."
else
  echo "Creating Terraform state bucket $BUCKET in $REGION."
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
