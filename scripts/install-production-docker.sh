#!/usr/bin/env bash
# Run as root through SSM on Ubuntu/Debian or Amazon Linux (x86_64).
set -euo pipefail

if [[ $(id -u) != 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# shellcheck disable=SC1091
source /etc/os-release
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  case "$ID" in
    ubuntu|debian) apt-get update; apt-get install -y ca-certificates curl unzip ;;
    amzn) yum install -y ca-certificates curl unzip ;;
    *) echo "Unsupported Docker host OS: $ID" >&2; exit 1 ;;
  esac
fi

if ! docker compose version >/dev/null 2>&1; then
  case "$ID" in
    ubuntu|debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y ca-certificates curl unzip
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$(dpkg --print-architecture)" "$ID" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    amzn)
      yum install -y docker unzip curl
      # Amazon Linux packages Docker Engine but not the Compose CLI plugin.
      compose_version=v2.39.4
      compose_tmp=$(mktemp -d)
      curl -fsSL "https://github.com/docker/compose/releases/download/$compose_version/docker-compose-linux-x86_64" \
        -o "$compose_tmp/docker-compose-linux-x86_64"
      curl -fsSL "https://github.com/docker/compose/releases/download/$compose_version/checksums.txt" \
        -o "$compose_tmp/checksums.txt"
      (cd "$compose_tmp" && grep -E ' [*]?docker-compose-linux-x86_64$' checksums.txt | sha256sum -c -)
      install -Dm755 "$compose_tmp/docker-compose-linux-x86_64" /usr/local/lib/docker/cli-plugins/docker-compose
      rm -rf "$compose_tmp"
      ;;
    *) echo "Unsupported Docker host OS: $ID" >&2; exit 1 ;;
  esac
fi

systemctl enable --now docker

if ! command -v aws >/dev/null; then
  cli_tmp=$(mktemp -d)
  trap 'rm -rf "$cli_tmp"' EXIT
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o "$cli_tmp/aws.zip"
  unzip -q "$cli_tmp/aws.zip" -d "$cli_tmp"
  "$cli_tmp/aws/install"
fi

docker compose version
