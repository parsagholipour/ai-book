#!/bin/sh
set -e

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
