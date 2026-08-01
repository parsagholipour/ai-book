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

has_deps() {
  node -e "
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const pkg = process.env.DEV_DEPS_PACKAGE || 'nodemon';
    try {
      createRequire(join('/app', 'package.json')).resolve(pkg + '/package.json');
      process.exit(0);
    } catch {
      process.exit(1);
    }
  "
}

if ! DEV_DEPS_PACKAGE="$deps_package" has_deps; then
  filter="${DEV_PNPM_FILTER:-.}"
  echo "[dev] Installing dependencies for ${filter} (node_modules volume is empty or stale)..."
  pnpm install --filter "${filter}"
fi

exec "$@"
