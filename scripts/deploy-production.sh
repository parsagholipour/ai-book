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

# Where a failure leaves the host, read by on_exit: `preflight` touches nothing
# running, `stopping` has stopped the running release but changed no schema,
# `migrating` and `starting` may have, `web` has replaced web alone, and `live`
# is the new release serving.
phase=preflight

# Prevent overlapping remote commands even if a GitHub run is cancelled.
# BOOK_MAKER_DEPLOY_LOCK and BOOK_MAKER_ROOT exist only so
# scripts/test_deploy_production.py can run this against a scratch directory.
exec 9>"${BOOK_MAKER_DEPLOY_LOCK:-/var/lock/book-maker-deploy.lock}"
flock -w 1800 9

root=${BOOK_MAKER_ROOT:-/opt/book-maker}
# The pre-migration dump goes to the assets bucket under a prefix no
# application key can name (objectKey's categories are books, images, voice,
# audio and attachments). storage.tf expires it after 30 days.
dump_prefix=db-backups
database_dump=""
running_services=()
stopped_services=()
# Present from the moment a full cutover stops anything until a release is live.
# A web-only release trusts the running API and worker to be `current`'s, and a
# cutover that failed partway may have left them stopped, or started from images
# `current` does not name.
cutover_marker=$root/cutover-incomplete

# One disk holds the OS, every Docker image, and the PostgreSQL and Redis
# volumes. A pull that fills it fails halfway, and Postgres panics on its next
# WAL write while Redis fails its AOF writes. A release that changes the base
# image brings the whole app image: about 2 GiB unpacked, plus its compressed
# blobs on a containerd image store. Pull only with room for that and for the
# databases to keep writing, and start the cutover only if that room survived.
pull_floor_gib=4
cutover_floor_gib=2

# Free KiB on the fullest filesystem Docker keeps images on. The containerd
# image store keeps layers outside DockerRootDir, in /var/lib/containerd.
docker_free_kib() {
  local dirs
  dirs=("$(docker info --format '{{.DockerRootDir}}')")
  if [[ -d /var/lib/containerd ]]; then
    dirs+=(/var/lib/containerd)
  fi
  df -Pk "${dirs[@]}" | awk 'NR > 1 && (min == "" || $4 < min) { min = $4 } END { print min }'
}

require_free_gib() {
  local floor_gib=$1 action=$2 free_kib
  free_kib=$(docker_free_kib)
  if (( free_kib < floor_gib * 1024 * 1024 )); then
    printf 'Refusing to %s: %d MiB free on the disk under Docker, PostgreSQL and Redis; this step needs %d GiB.\n' \
      "$action" $((free_kib / 1024)) "$floor_gib" >&2
    echo "The running release is untouched. Free space without deleting Docker volumes, or raise ROOT_VOLUME_SIZE, then rerun (docs/deployment.md)." >&2
    df -h / "$(docker info --format '{{.DockerRootDir}}')" >&2 || true
    docker system df >&2 || true
    exit 1
  fi
}

# The two image references a release directory recorded. Read, never sourced:
# this shell is root.
release_images() {
  if [[ -f $1/images.env ]]; then
    sed -n -E 's/^(APP|WEB)_IMAGE=//p' "$1/images.env"
  fi
}

# Delete every image that no container uses and that is not one of the named
# releases' images. Never `docker image prune`: images are pulled by digest and
# carry no tag, so Docker counts the previous release's images as dangling and
# prune deletes the rollback. Any failed read deletes nothing.
prune_images() {
  local keep used listed inspected id names name
  local -a ids
  keep=$(for release in "$@"; do release_images "$release"; done)
  used=$(docker ps --all --quiet --no-trunc | xargs -r docker container inspect --format '{{.Image}}') || return 1
  listed=$(docker image ls --quiet --no-trunc | sort -u) || return 1
  [[ -n $listed ]] || return 0
  mapfile -t ids <<<"$listed"
  inspected=$(docker image inspect \
    --format '{{.Id}}{{range .RepoDigests}} {{.}}{{end}}{{range .RepoTags}} {{.}}{{end}}' "${ids[@]}") || return 1
  while read -r id names; do
    if grep -qxF "$id" <<<"$used"; then
      continue
    fi
    for name in $names; do
      if grep -qxF "$name" <<<"$keep"; then
        continue 2
      fi
    done
    if docker image rm --force "$id" >/dev/null; then
      echo "Removed image ${names:-$id}"
    else
      echo "Could not remove image $id" >&2
    fi
  done <<<"$inspected"
}

# A custom-format dump of the whole database, streamed into the assets bucket.
# Streamed, never written here first: this disk holds PostgreSQL itself, and a
# dump file would spend the room the disk guard keeps for it. pg_dump's exit
# status is what proves the dump whole, and with pipefail a failure on either
# side fails the pipeline; the partial object that leaves is removed.
dump_database() {
  local key uri size
  key="$dump_prefix/$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$PWD").dump"
  uri="s3://$S3_BUCKET/$key"
  echo "Dumping the database to $uri"
  if ! "${compose[@]}" exec -T postgres pg_dump --username bookmaker --dbname bookmaker --format custom \
    | aws s3 cp - "$uri" --only-show-errors; then
    aws s3 rm "$uri" --only-show-errors >/dev/null 2>&1 || true
    echo "The database dump or its upload failed." >&2
    return 1
  fi
  size=$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" --query ContentLength --output text)
  if [[ ! $size =~ ^[1-9][0-9]*$ ]]; then
    echo "The uploaded database dump $uri is missing or empty." >&2
    return 1
  fi
  database_dump=$uri
  printf 'Database dump: %s (%d KiB)\n' "$uri" $((size / 1024))
}

# Starts again exactly the containers this deploy stopped, as they were: no
# image, configuration or recreate decision is made, so what comes back is the
# release that was running and nothing else. Only before `migrate`: after it,
# the old images may not read the schema (docs/deployment.md, "Restoring the
# database before a release").
restart_stopped_release() {
  local service id
  (( ${#stopped_services[@]} )) || return 0
  echo "Nothing was migrated. Starting the running release's ${stopped_services[*]} again." >&2
  for service in "${stopped_services[@]}"; do
    for id in $("${compose[@]}" ps --all --quiet "$service"); do
      docker start "$id" >/dev/null || echo "Could not start $service ($id)." >&2
    done
  done
}

# A release whose app image, runtime environment and compose file are all the
# running release's differs only in the web image (the Flutter app, the console's
# static files, nginx's configuration), so it replaces web alone while the API
# and worker keep serving: no drain, no dump and no migration, because the schema
# is the app image's. Anything the running release cannot vouch for takes the
# full cutover instead.
web_only_release() {
  local running=$root/current
  [[ ! -e $cutover_marker ]] || return 1
  [[ -f $running/images.env && -f $running/.env && -f $running/docker-compose.production.yml ]] || return 1
  [[ "$(sed -n -E 's/^APP_IMAGE=//p' "$running/images.env")" == "$APP_IMAGE" ]] || return 1
  cmp -s .env "$running/.env" || return 1
  cmp -s docker-compose.production.yml "$running/docker-compose.production.yml" || return 1
  [[ " ${running_services[*]} " == *" api "* && " ${running_services[*]} " == *" worker "* ]]
}

# Puts the running release's web image back after a failed web-only release.
# Nothing else was touched, and the compose file and environment are the running
# release's, so what comes back is the web the API and worker were serving behind.
restore_running_web() {
  local image
  image=$(sed -n -E 's/^WEB_IMAGE=//p' "$root/current/images.env")
  [[ -n $image ]] || return 1
  echo "The new web did not pass its checks. Starting the running release's web again." >&2
  WEB_IMAGE=$image "${compose[@]}" up -d --no-deps --wait --wait-timeout 120 web
}

on_exit() {
  local status=$?
  docker logout "$registry" >/dev/null 2>&1 || true
  if (( status != 0 )); then
    case $phase in
      stopping)
        restart_stopped_release || true
        ;;
      migrating | starting)
        echo "The release failed after the database dump, and its applications are left stopped:" >&2
        echo "the schema may have changed, and the older images cannot be started on it blind." >&2
        echo "Fix forward and rerun the workflow, or restore ${database_dump:-the dump} and start the" >&2
        echo "running release (docs/deployment.md, \"Restoring the database before a release\")." >&2
        ;;
      web)
        restore_running_web || echo "Could not start the running release's web again." >&2
        ;;
    esac
  fi
  exit "$status"
}

aws ssm get-parameter --name "$parameter" --with-decryption \
  --query Parameter.Value --output text > .env
chmod 600 .env
printf 'APP_IMAGE=%s\nWEB_IMAGE=%s\nS3_BUCKET=%s\nS3_REGION=%s\n' \
  "$APP_IMAGE" "$WEB_IMAGE" "$S3_BUCKET" "$S3_REGION" > images.env
registry=${APP_IMAGE%%/*}
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
trap on_exit EXIT

compose=(docker compose --env-file .env -f docker-compose.production.yml)
"${compose[@]}" config --quiet
# Room first: drop what neither this release, the running one nor the rollback
# can use (a failed release's images, images a host collected before this
# rule), then refuse to pull onto a disk without room for a whole image.
prune_images "$PWD" "$root/current" "$root/previous" || echo "Image cleanup before the pull failed; checking free space anyway." >&2
require_free_gib "$pull_floor_gib" "pull the release images"
"${compose[@]}" pull
require_free_gib "$cutover_floor_gib" "stop the running release after the pull"
# Refuse a PRODUCTION_ENV the new release would not boot on while the running
# release is still serving: the same check the api and worker make at startup
# (packages/core/src/productionConfig.ts), run in the new image. It names every
# missing setting and prints no value. Past this point the old release is
# stopped, and a refusal at boot would be an outage.
"${compose[@]}" run --rm --no-deps api node --import tsx src/checkProductionConfig.ts

# What is running now, in start order, so that a failure before `migrate` can
# put back exactly this.
for service in api worker web; do
  if [[ -n $("${compose[@]}" ps --quiet --status running "$service") ]]; then
    running_services+=("$service")
  fi
done

if web_only_release; then
  echo "The app image, environment and compose file are the running release's: replacing web alone."
  phase=web
  # The recreate costs the seconds between the old nginx stopping and the new one
  # answering; Caddy answers 502 meanwhile, as it does during a full cutover.
  "${compose[@]}" up -d --no-deps --wait --wait-timeout 120 web
else
  stopped_services=("${running_services[@]}")
  : > "$cutover_marker"
  phase=stopping
  # The worker drains first, alone, while the API and web keep serving: it gets
  # up to its stop_grace_period (5 minutes) to finish its jobs and keeps beating
  # while it does, and work the API queues meanwhile waits in Redis for the new
  # worker. The outage starts only after it, with the API's stop. Caddy keeps
  # running throughout: it answers 502 while web is down, keeps TLS up and its
  # certificates, and re-resolves web:80 when the new container appears.
  "${compose[@]}" stop worker
  "${compose[@]}" stop api web
  # After the drain and the API's stop, not before: a changed postgres or redis
  # definition (a new pgvector image under its moving tag, a memory setting)
  # recreates that container, which would cut the connections of whatever still
  # used it. Unchanged, this is a no-op; on a new host it starts them.
  "${compose[@]}" up -d --wait --wait-timeout 180 postgres redis
  # A migration that adds enum values the running images cannot read has no way
  # back but a restore, so nothing is migrated until the database it changes is
  # in S3. Taken with every writer stopped, the dump is exactly the state the
  # migration starts from. A failed dump restarts the running release (on_exit).
  dump_database
  printf '%s\n' "$database_dump" > database-dump
  phase=migrating
  # A failed migration leaves the applications stopped and fails the deployment;
  # it must never be ignored.
  "${compose[@]}" run --rm --no-deps migrate
  phase=starting
  "${compose[@]}" up -d --no-deps --wait --wait-timeout 240 api worker web
fi
# Recreated after web is healthy so a new edge never waits on an absent upstream.
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 caddy
# Through the published edge: Caddy -> Nginx -> API.
curl --fail --silent --show-error http://127.0.0.1/api/health
phase=live
rm -f "$cutover_marker"

# Only mark a release current after every service passes its checks. The
# release it replaces becomes `previous`, the rollback whose images stay on the
# host; a rerun of the same images keeps the older rollback instead.
outgoing=$(readlink -f "$root/current" || true)
if [[ -n $outgoing && $outgoing != "$(pwd -P)" && -f $outgoing/images.env \
  && "$(release_images "$outgoing")" != "$(release_images "$PWD")" ]]; then
  ln -sfn "$outgoing" "$root/previous"
fi
ln -sfn "$PWD" "$root/current"
"${compose[@]}" ps
# Keep exactly this release's and the previous release's images plus whatever a
# container uses. Volumes are never touched. The release is already live, so a
# cleanup failure is reported, not fatal.
prune_images "$root/current" "$root/previous" || echo "Image cleanup after the release failed; the release is live." >&2
df -h /
# The memory budget (docs/deployment.md, "Memory budget and swap") assumes the
# swapfile Terraform creates and a Redis well under its maxmemory, where a full
# Redis refuses every queue write. Reported, never fatal: the release is live.
free -h || true
if [[ -z $(swapon --show --noheadings 2>/dev/null) ]]; then
  echo "Warning: no swap is active; apply Terraform (aws_ssm_association.swap)." >&2
fi
"${compose[@]}" exec -T redis redis-cli info memory | grep -E '^(used_memory_human|maxmemory_human):' || true
