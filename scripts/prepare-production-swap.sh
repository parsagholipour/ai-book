#!/usr/bin/env bash
# A 2 GiB swapfile and vm.swappiness=10 on the production instance.
#
# docker-compose.production.yml gives the api and worker hard memory ceilings
# with no swap of their own. This file is for everything that has no ceiling:
# PostgreSQL, Redis, the edge, the OS and the SSM agent. Without it a burst
# past physical memory goes straight to the kernel OOM killer (or thrashes the
# page cache until SSM stops answering); with it the burst is paged out and the
# host stays reachable. Low swappiness keeps it a cushion, not a working set:
# the kernel drops page cache long before it swaps anonymous memory.
# docs/deployment.md, "Memory budget and swap".
#
# Run through SSM as root after prepare-production-disk.sh (Terraform:
# aws_ssm_association.swap). Safe to rerun: an active swapfile is never switched
# off or rewritten, because swapoff on a busy host forces every swapped page
# back into memory at once.
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
export LC_ALL=C

# Paths are overridable only so scripts/test_prepare_production_swap.py can run
# without root; SSM runs this with the defaults.
swapfile=${BOOK_MAKER_SWAPFILE:-/swapfile}
fstab=${BOOK_MAKER_FSTAB:-/etc/fstab}
sysctl_conf=${BOOK_MAKER_SYSCTL_CONF:-/etc/sysctl.d/90-book-maker-swap.conf}
swap_mib=2048
swappiness=10
# The swapfile shares the disk with Docker's images and the database volumes.
# Leave what scripts/deploy-production.sh refuses to pull without (4 GiB).
deploy_floor_mib=$((4 * 1024))

if [[ $(id -u) != 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

# Right with or without the file, so it is applied first and every time.
printf '# Managed by scripts/prepare-production-swap.sh\nvm.swappiness = %d\n' "$swappiness" > "$sysctl_conf"
sysctl -q -w "vm.swappiness=$swappiness"

active=$(swapon --show=NAME --noheadings)
if grep -qxF "$swapfile" <<<"$active"; then
  size=$(stat -c %s "$swapfile")
  if (( size != swap_mib * 1024 * 1024 )); then
    printf 'Note: %s is active at %d MiB, not %d MiB. It is left as it is; to resize, run swapoff while the host has free memory, delete it, and rerun this script.\n' \
      "$swapfile" $((size / 1024 / 1024)) "$swap_mib"
  else
    echo "$swapfile is already active."
  fi
else
  # Not in use, so it holds nothing: whatever is there (an interrupted run,
  # a file someone switched off) is replaced rather than trusted.
  rm -f "$swapfile" "$swapfile.partial"
  free_mib=$(( $(df -k --output=avail "$(dirname "$swapfile")" | tail -n 1 | tr -d ' ') / 1024 ))
  if (( free_mib < swap_mib + deploy_floor_mib )); then
    printf 'Only %d MiB free on %s: a %d MiB swapfile would leave less than the %d MiB the deploy needs to pull a release.\n' \
      "$free_mib" "$(dirname "$swapfile")" "$swap_mib" "$deploy_floor_mib" >&2
    echo "Increase ROOT_VOLUME_SIZE and apply Terraform, or free unused images, then rerun." >&2
    exit 1
  fi
  # Written out in full rather than fallocate'd: a preallocated file can carry
  # unwritten extents, which swapon refuses on some XFS kernels ("has holes").
  # Built under another name so the real path only ever holds a whole swapfile.
  (umask 077 && dd if=/dev/zero of="$swapfile.partial" bs=1M count="$swap_mib" status=none)
  chmod 600 "$swapfile.partial"
  mkswap "$swapfile.partial" >/dev/null
  mv "$swapfile.partial" "$swapfile"
  swapon "$swapfile"
  echo "Created and enabled $swapfile ($swap_mib MiB)."
fi

# Across reboots and the stop/start an instance-type change makes.
if ! awk -v file="$swapfile" '$1 == file && $3 == "swap" { found = 1 } END { exit !found }' "$fstab"; then
  if [[ -s $fstab && -n $(tail -c 1 "$fstab") ]]; then
    echo >> "$fstab"
  fi
  printf '%s none swap sw 0 0\n' "$swapfile" >> "$fstab"
fi

swapon --show
free -h
