#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed or not on PATH" >&2
  exit 1
fi

docker_bin="$(command -v docker)"
if [[ "$docker_bin" == /snap/* ]] && snap list docker >/dev/null 2>&1; then
  if ! snap connections docker 2>/dev/null | awk '$1 == "removable-media" { print $3 }' | grep -q ':removable-media'; then
    echo "Snap Docker cannot read this project on an external drive until removable-media access is enabled."
    echo "Run once:"
    echo "  sudo snap connect docker:removable-media"
    echo
    if sudo -n snap connect docker:removable-media 2>/dev/null; then
      echo "Enabled removable-media access for Snap Docker."
    else
      exit 1
    fi
  fi
fi

if ! docker compose -f "$project_dir/docker-compose.yml" config >/dev/null 2>&1; then
  echo "error: Docker still cannot read files in:" >&2
  echo "  $project_dir" >&2
  echo >&2
  echo "If this project lives on an external drive, run:" >&2
  echo "  sudo snap connect docker:removable-media" >&2
  echo >&2
  echo "Or move the repo into your home directory (for example ~/projects/ai-book-maker)." >&2
  exit 1
fi
