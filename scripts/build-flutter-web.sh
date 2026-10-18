#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir/apps/mobile"
flutter pub get --enforce-lockfile
flutter build web --release --no-pub --pwa-strategy=none \
  --dart-define=APP_ENV=production \
  --dart-define=API_BASE_URL=https://app.tomeza.ravanix.app
mkdir -p "$repo_dir/deploy/flutter-web"
# Only this generated directory is replaced; no source or server files.
rsync -a --delete build/web/ "$repo_dir/deploy/flutter-web/"
