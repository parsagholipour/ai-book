#!/usr/bin/env bash
# Run from the release directory as root via SSM. Arguments contain no secrets.
set -euo pipefail
umask 077
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

export AWS_DEFAULT_REGION=${1:?AWS region is required}
parameter=${2:?SSM environment parameter is required}
export APP_IMAGE=${3:?App image digest is required}
export WEB_IMAGE=${4:?Web image digest is required}
export S3_BUCKET=${5:?S3 assets bucket is required}
export S3_REGION=$AWS_DEFAULT_REGION
export AWS_PAGER=""

# Prevent overlapping remote commands even if a GitHub run is cancelled.
exec 9>/var/lock/book-maker-deploy.lock
flock -w 1800 9

aws ssm get-parameter --name "$parameter" --with-decryption \
  --query Parameter.Value --output text > .env
chmod 600 .env
printf 'APP_IMAGE=%s\nWEB_IMAGE=%s\nS3_BUCKET=%s\nS3_REGION=%s\n' \
  "$APP_IMAGE" "$WEB_IMAGE" "$S3_BUCKET" "$S3_REGION" > images.env
registry=${APP_IMAGE%%/*}
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT

compose=(docker compose --env-file .env -f docker-compose.production.yml)
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --wait --wait-timeout 180 postgres redis

# Drain jobs before changing the database schema. Failed migrations leave the
# applications stopped and fail the deployment; they must never be ignored.
# Caddy keeps running: it answers 502 meanwhile, keeps TLS up and its
# certificates, and re-resolves web:80 when the new container appears.
"${compose[@]}" stop worker api web
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 240 api worker web
# Recreated after web is healthy so a new edge never waits on an absent upstream.
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 caddy
# Through the published edge: Caddy -> Nginx -> API.
curl --fail --silent --show-error http://127.0.0.1/api/health

# Only mark a release current after every service passes its checks.
ln -sfn "$PWD" /opt/book-maker/current
"${compose[@]}" ps
# Remove unused image layers, never persistent volumes.
docker image prune --all --force --filter until=168h
