#!/usr/bin/env bash
# EBS resizing does not grow an existing root partition/filesystem by itself.
# Run before package installation and image pulls, while SSM can still write.
set -euo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
export LC_ALL=C

if [[ $(id -u) != 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

read -r root_device root_fs < <(findmnt -n -o SOURCE,FSTYPE /)
root_device=$(readlink -f "$root_device")
case "$root_fs" in
  ext4) resize_tool=resize2fs ;;
  xfs) resize_tool=xfs_growfs ;;
  *) echo "Unsupported root filesystem: $root_fs; extend it manually before deploying." >&2; exit 1 ;;
esac
command -v "$resize_tool" >/dev/null || {
  echo "Install $resize_tool before deploying; the root filesystem must use the full EBS volume." >&2
  exit 1
}

case "$(lsblk -dn -o TYPE "$root_device")" in
  part)
    parent=$(lsblk -dn -o PKNAME "$root_device")
    disk="/dev/$parent"
    # Nitro: /dev/nvme0n1p1; Xen: /dev/xvda1. Never assume a device or partition number.
    partition=${root_device#"$disk"}
    partition=${partition#p}
    if [[ -z "$parent" || ! "$partition" =~ ^[0-9]+$ ]]; then
      echo "Cannot determine the root partition for $root_device." >&2
      exit 1
    fi
    command -v growpart >/dev/null || {
      echo "Install growpart (cloud-guest-utils / cloud-utils-growpart) before deploying." >&2
      exit 1
    }
    # /run is tmpfs: growpart needs temporary space even when / is already full.
    if output=$(TMPDIR=/run growpart "$disk" "$partition" 2>&1); then
      printf '%s\n' "$output"
    else
      status=$?
      printf '%s\n' "$output"
      # growpart returns 1 when the partition already fills the available space.
      if [[ $status != 1 || "$output" != NOCHANGE:* ]]; then
        exit "$status"
      fi
    fi
    ;;
  disk) ;; # Some AMIs put the filesystem directly on the disk.
  *) echo "Unsupported root block layout for $root_device; extend it manually before deploying." >&2; exit 1 ;;
esac

# Also run after NOCHANGE: a previous attempt may have grown only the partition.
case "$root_fs" in
  ext4) resize2fs "$root_device" ;;
  xfs) xfs_growfs -d / ;;
esac
df -h /
free_kb=$(df -k --output=avail / | tail -n 1 | tr -d ' ')
if (( free_kb < 2 * 1024 * 1024 )); then
  echo "Less than 2 GiB free on /. Increase ROOT_VOLUME_SIZE and apply Terraform, or free unused images before deploying." >&2
  exit 1
fi
