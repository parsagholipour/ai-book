#!/usr/bin/env bash
# One-time fix: Docker without sudo in ALL terminals (existing + new).
# Run: sudo bash scripts/fix-docker-access-global.sh
set -euo pipefail

TARGET_USER="${SUDO_USER:-${USER}}"
if [[ -z "${TARGET_USER}" || "${TARGET_USER}" == "root" ]]; then
  echo "Run with sudo so SUDO_USER is set, e.g.: sudo bash $0"
  exit 1
fi

echo "==> Configuring Docker access for user: ${TARGET_USER}"

# Standard group-based access (applies to new logins / new sessions)
if ! getent group docker >/dev/null; then
  groupadd docker
fi
usermod -aG docker "${TARGET_USER}"

# Immediate access in every already-open terminal (no logout required)
for sock in /var/run/docker.sock /run/docker.sock; do
  if [[ -S "${sock}" ]]; then
    setfacl -m "user:${TARGET_USER}:rw" "${sock}"
    echo "    ACL set on ${sock}"
  fi
done

# Re-apply ACL when snap Docker restarts
mkdir -p /etc/systemd/system/snap.docker.dockerd.service.d
cat > /etc/systemd/system/snap.docker.dockerd.service.d/50-docker-socket-acl.conf <<EOF
[Service]
ExecStartPost=/usr/bin/setfacl -m u:${TARGET_USER}:rw /var/run/docker.sock /run/docker.sock
EOF

systemctl daemon-reload

echo ""
echo "Done. Test in ANY open terminal (no logout needed):"
echo "  docker ps"
echo "  make logs-api"
echo ""
echo "Optional: log out and back in once so group membership is clean everywhere."
