#!/usr/bin/env bash
# Exercise the production images with mock providers and disposable data.
set -euo pipefail

: "${APP_IMAGE:?Set APP_IMAGE}"
: "${WEB_IMAGE:?Set WEB_IMAGE}"
export APP_IMAGE WEB_IMAGE
export S3_BUCKET=book-maker-smoke S3_REGION=us-east-1
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
# CI supplies its cached, locally loaded image. Standalone runs build the same
# Dockerfile rather than relying on MinIO's withdrawn public registry images.
if [[ -z "${MINIO_IMAGE:-}" ]]; then
  MINIO_IMAGE=book-maker-minio:local
  docker build --tag "$MINIO_IMAGE" "$repo_dir/deploy/minio"
fi
export MINIO_IMAGE
smoke_dir=$(mktemp -d)
project="book-maker-smoke-${GITHUB_RUN_ID:-$$}"
# The Compose file mounts ./deploy/Caddyfile relative to the project directory.
mkdir -p "$smoke_dir/deploy"
cp "$repo_dir/deploy/Caddyfile" "$smoke_dir/deploy/Caddyfile"
# Production refuses to start without these (packages/core/src/productionConfig.ts),
# so the smoke test sets them rather than skipping the check: the containers
# below boot through exactly the code a real release does. They are dummies:
# nothing here reaches Google, an SMTP server or the public origin. The provider
# keys are the one thing waived, and only because MOCK_AI calls no provider;
# ALLOW_MOCK_AI_IN_PRODUCTION is what lets MOCK_AI into production, and the
# API and worker log an error at boot whenever it is on.
cat > "$smoke_dir/.env" <<'ENV'
POSTGRES_PASSWORD=smoke-test-password
WEB_PASSWORD=smoke-test-operator-password
PUBLIC_API_URL=https://smoke.tomeza.invalid
GOOGLE_PLAY_PACKAGE_NAME=com.tomeza.smoke
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON='{"client_email":"play@smoke.invalid","private_key":"smoke-test-not-a-key"}'
GOOGLE_PLAY_RTDN_AUDIENCE=https://smoke.tomeza.invalid/api/billing/google-play/rtdn
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=play-rtdn@smoke.invalid
SMTP_URL=smtp://smtp.smoke.invalid:587
MOCK_AI=true
ALLOW_MOCK_AI_IN_PRODUCTION=true
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
    image: ${MINIO_IMAGE:?Set MINIO_IMAGE}
    pull_policy: never
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
    image: ${MINIO_IMAGE:?Set MINIO_IMAGE}
    pull_policy: never
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
# The deploy's preflight (scripts/deploy-production.sh) passes on this .env,
"${compose[@]}" run --rm --no-deps api node --import tsx src/checkProductionConfig.ts
# and refuses one that lacks required settings, naming each and printing no value.
if refusal=$("${compose[@]}" run --rm --no-deps -e SMTP_URL= -e WEB_PASSWORD=too-short \
  api node --import tsx src/checkProductionConfig.ts 2>&1); then
  echo "The production config check accepted a release without SMTP_URL and with a weak WEB_PASSWORD" >&2
  exit 1
fi
for expected in SMTP_URL WEB_PASSWORD; do
  if ! grep -q "$expected" <<<"$refusal"; then
    printf 'The production config refusal did not name %s:\n%s\n' "$expected" "$refusal" >&2
    exit 1
  fi
done
if grep -q -e too-short -e smoke-test-not-a-key <<<"$refusal"; then
  printf 'The production config refusal printed a value:\n%s\n' "$refusal" >&2
  exit 1
fi
"${compose[@]}" run --rm --no-deps minio-init
# Parse and provision the edge config without starting it (no ACME traffic).
"${compose[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
"${compose[@]}" up -d --wait --wait-timeout 240 postgres redis api worker web
address=$("${compose[@]}" port web 80)
curl --fail --silent --show-error "http://$address/api/health"
curl --fail --silent --show-error "http://$address/projects" | grep -q '<div id="root">'
# Both frontends ship together, selected by Host, including Flutter deep links.
curl --fail --silent --show-error -H 'Host: app.tomeza.ravanix.app' \
  "http://$address/books" | grep -q 'flutter_bootstrap.js'
curl --fail --silent --show-error -H 'Host: app.tomeza.ravanix.app' \
  "http://$address/flutter_bootstrap.js" --output /dev/null
curl --fail --silent --show-error -H 'Host: app.tomeza.ravanix.app' \
  "http://$address/api/health" --output /dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H 'Host: app.tomeza.ravanix.app' "http://$address/api/admin/users")" = 404

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

# Repeat the same sequence as a deployment to an already running instance
# (scripts/deploy-production.sh): the worker drains alone, then the API stops.
"${compose[@]}" stop worker
"${compose[@]}" stop api web
"${compose[@]}" up -d --wait --wait-timeout 60 postgres redis
# The deploy's pre-migration dump, with its exact pg_dump flags, restored the way
# docs/deployment.md ("Restoring the database before a release") restores it,
# into a scratch database: a restore rehearsed against the real schema
# (pgvector, the enums, every index) on every release. Only the S3 hop differs.
"${compose[@]}" exec -T postgres pg_dump --username bookmaker --dbname bookmaker --format custom \
  > "$smoke_dir/database.dump"
"${compose[@]}" exec -T postgres createdb --username bookmaker bookmaker_restore_check
"${compose[@]}" exec -T postgres pg_restore --username bookmaker --dbname bookmaker_restore_check \
  --no-owner --exit-on-error < "$smoke_dir/database.dump"
migrations() {
  "${compose[@]}" exec -T postgres psql --username bookmaker --dbname "$1" -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'
}
applied=$(migrations bookmaker)
restored=$(migrations bookmaker_restore_check)
if [[ $applied == 0 || $applied != "$restored" ]]; then
  echo "The restored dump has $restored applied migrations; the database had $applied" >&2
  exit 1
fi
"${compose[@]}" exec -T postgres dropdb --username bookmaker bookmaker_restore_check
# Rehearse the owner's closed debug deployment on the restart: the production
# images boot without Play/mail credentials and refuse all new email accounts.
cat >> "$smoke_dir/.env" <<'ENV'
DEBUG_MODE=true
GOOGLE_PLAY_PACKAGE_NAME=
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
GOOGLE_PLAY_RTDN_AUDIENCE=
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=
SMTP_URL=
ENV
"${compose[@]}" run --rm --no-deps api node --import tsx src/checkProductionConfig.ts
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --force-recreate --no-deps --wait --wait-timeout 240 api worker web
address=$("${compose[@]}" port web 80)
curl --fail --silent --show-error "http://$address/api/health"
"${compose[@]}" exec -T api node --input-type=module -e '
  import assert from "node:assert/strict";
  const response = await fetch("http://localhost:4001/api/mobile/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "debug-smoke@example.invalid", password: "smoke-test-password",
      termsAccepted: true, ageGuardianAttested: true })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "SIGNUP_DISABLED");
  console.log("Debug deployment refuses new accounts.");
'
"${compose[@]}" exec -T api node --import tsx --input-type=module -e '
  import assert from "node:assert/strict";
  import { objectStore, objectKey } from "@book-maker/storage";
  const key = objectKey("books", "deployment-smoke", "probe.txt");
  assert.equal((await objectStore().get(key))?.toString(), "shared");
  await objectStore().delete(key);
  assert.equal(await objectStore().get(key), null);
'
"${compose[@]}" ps
