#!/bin/sh
set -e

# The repo is bind-mounted and this container runs as root, so every file it
# writes under /app/storage lands in the working tree owned by root. A host-side
# `pnpm dev` runs as the host user and cannot write into a root-owned 0755
# directory — it fails with EACCES the moment it picks up a job for a project the
# container created first. Keep container-written files group/world writable so
# both sides can share the mount.
umask 0000

cd /app

deps_package="${DEV_DEPS_PACKAGE:-nodemon}"
filter="${DEV_PNPM_FILTER:-.}"

# node_modules lives in an anonymous volume that outlives every `docker compose
# up`, so "is it installed" has to mean "does it match the lockfile" and not
# "is there anything in there". Probing a single sentinel package only answered
# the second question: a dependency added to packages/core after the volume was
# created stayed missing forever, and surfaced as a job failing on
# `Cannot find module` deep inside a run rather than as a failed boot.
has_deps() {
  node -e "
    const { createRequire } = require('node:module');
    try {
      createRequire('/app/package.json').resolve(process.env.DEV_DEPS_PACKAGE + '/package.json');
      process.exit(0);
    } catch {
      process.exit(1);
    }
  "
}

# The filter is part of the stamp because each service installs a different
# slice of the workspace — a volume filled for @book-maker/web is stale for the
# worker even on an unchanged lockfile.
stamp_file="/app/node_modules/.dev-deps-stamp"
current_stamp() {
  node -e "
    const { createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');
    const hash = createHash('sha256');
    hash.update(process.env.DEV_PNPM_FILTER_STAMP + '\0');
    hash.update(readFileSync('/app/pnpm-lock.yaml'));
    process.stdout.write(hash.digest('hex'));
  "
}

want_stamp="$(DEV_PNPM_FILTER_STAMP="$filter" current_stamp)"
have_stamp="$(cat "$stamp_file" 2>/dev/null || true)"

if ! DEV_DEPS_PACKAGE="$deps_package" has_deps; then
  reason="node_modules volume is empty"
elif [ "$have_stamp" != "$want_stamp" ]; then
  reason="lockfile changed since this volume was installed"
fi

if [ -n "${reason:-}" ]; then
  echo "[dev] Installing dependencies for ${filter} (${reason})..."
  pnpm install --filter "${filter}"
  # Only after a successful install: `set -e` aborts above on failure, so a
  # broken install must not leave a stamp claiming the volume is current.
  printf '%s' "$want_stamp" > "$stamp_file"
fi

exec "$@"
