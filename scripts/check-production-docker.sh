#!/usr/bin/env bash
# Exercise the production images with mock providers and disposable data.
set -euo pipefail

: "${APP_IMAGE:?Set APP_IMAGE}"
: "${WEB_IMAGE:?Set WEB_IMAGE}"
export APP_IMAGE WEB_IMAGE
export S3_BUCKET=book-maker-smoke S3_REGION=us-east-1
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
smoke_dir=$(mktemp -d)
project="book-maker-smoke-${GITHUB_RUN_ID:-$$}"
# The Compose file mounts ./deploy/Caddyfile relative to the project directory.
mkdir -p "$smoke_dir/deploy"
cp "$repo_dir/deploy/Caddyfile" "$smoke_dir/deploy/Caddyfile"
cat > "$smoke_dir/.env" <<'ENV'
POSTGRES_PASSWORD=smoke-test-password
WEB_PASSWORD=smoke-test-operator
PUBLIC_API_URL=http://localhost
MOCK_AI=true
S3_BUCKET=book-maker-smoke
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=bookmaker
AWS_SECRET_ACCESS_KEY=bookmaker-local-only
ENV
cat > "$smoke_dir/override.yml" <<'YAML'
services:
  minio:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
    command: [server, /data]
    environment:
      MINIO_ROOT_USER: bookmaker
      MINIO_ROOT_PASSWORD: bookmaker-local-only
    healthcheck:
      test: [CMD, curl, --fail, --silent, http://localhost:9000/minio/health/live]
      interval: 2s
      timeout: 5s
      retries: 30
  minio-init:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
    entrypoint: [/bin/sh, -ec]
    command:
      - |
        mc alias set local http://minio:9000 bookmaker bookmaker-local-only
        mc mb --ignore-existing local/book-maker-smoke
        mc anonymous set none local/book-maker-smoke
    depends_on:
      minio:
        condition: service_healthy
  # Caddy (the production edge) is never started here: no Let's Encrypt from
  # CI. The smoke test stays HTTP against Nginx on an ephemeral localhost port.
  web:
    ports: !override
      - "127.0.0.1::80"
YAML
compose=(docker compose -p "$project" --project-directory "$smoke_dir"
  --env-file "$smoke_dir/.env" -f "$repo_dir/docker-compose.production.yml"
  -f "$smoke_dir/override.yml")
cleanup() {
  status=$?
  if [[ "$status" != 0 ]]; then
    "${compose[@]}" logs --no-color --tail 100 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans || true
  rm -rf "$smoke_dir"
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up -d --wait --wait-timeout 60 minio
"${compose[@]}" run --rm --no-deps minio-init
# Parse and provision the edge config without starting it (no ACME traffic).
"${compose[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
"${compose[@]}" up -d --wait --wait-timeout 240 postgres redis api worker web
address=$("${compose[@]}" port web 80)
curl --fail --silent --show-error "http://$address/api/health"
curl --fail --silent --show-error "http://$address/projects" | grep -q '<div id="root">'
# Separate container filesystems must share only private S3 objects.
"${compose[@]}" exec -T worker node --import tsx --input-type=module -e '
  import { objectStore, objectKey } from "@book-maker/storage";
  await objectStore().put(objectKey("books", "deployment-smoke", "probe.txt"), "shared");
'
"${compose[@]}" exec -T api node --import tsx --input-type=module -e '
  import assert from "node:assert/strict";
  import { objectStore, objectKey } from "@book-maker/storage";
  assert.equal((await objectStore().get(objectKey("books", "deployment-smoke", "probe.txt")))?.toString(), "shared");
'
anonymous_status=$("${compose[@]}" exec -T minio curl --silent --output /dev/null --write-out '%{http_code}' \
  http://localhost:9000/book-maker-smoke/books/deployment-smoke/probe.txt)
test "$anonymous_status" = 403

# Repeat the same sequence as a deployment to an already running instance.
"${compose[@]}" stop worker api web
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --force-recreate --no-deps --wait --wait-timeout 240 api worker web
address=$("${compose[@]}" port web 80)
curl --fail --silent --show-error "http://$address/api/health"
"${compose[@]}" exec -T api node --import tsx --input-type=module -e '
  import assert from "node:assert/strict";
  import { objectStore, objectKey } from "@book-maker/storage";
  const key = objectKey("books", "deployment-smoke", "probe.txt");
  assert.equal((await objectStore().get(key))?.toString(), "shared");
  await objectStore().delete(key);
  assert.equal(await objectStore().get(key), null);
'
"${compose[@]}" ps
