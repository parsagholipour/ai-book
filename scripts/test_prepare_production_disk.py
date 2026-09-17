"""Exercise disk preparation with the incident's 20 GiB disk / 7 GiB partition."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("prepare-production-disk.sh")
STUBS = r'''
id() { echo 0; }
findmnt() { echo "${TEST_ROOT:-/dev/nvme0n1p1} ${TEST_FS:-ext4}"; }
readlink() { echo "${@: -1}"; }
lsblk() {
  case "$*" in
    *TYPE*) echo "${TEST_TYPE:-part}" ;;
    *PKNAME*) echo "${TEST_PARENT:-nvme0n1}" ;;
    *) return 2 ;;
  esac
}
growpart() {
  echo "growpart $* TMPDIR=$TMPDIR" >> "$TEST_CALLS"
  case "${TEST_GROW:-grow}" in
    grow) echo 'CHANGED: partition=1 size 14452703 -> 39587807' ;;
    full) echo 'NOCHANGE: partition 1 cannot be grown'; return 1 ;;
    error) echo 'FAILED: cannot update partition table'; return 2 ;;
  esac
}
resize2fs() {
  echo "resize2fs $*" >> "$TEST_CALLS"
  return "${TEST_RESIZE_STATUS:-0}"
}
xfs_growfs() { echo "xfs_growfs $*" >> "$TEST_CALLS"; }
df() {
  # Validate the actual GNU df options before returning synthetic free space.
  command df "$@" >/dev/null || return
  if [[ "$*" == *--output=avail* ]]; then
    printf 'Avail\n%s\n' "${TEST_FREE_KB:-12582912}"
  else
    echo 'Filesystem Size Used Avail Use% Mounted on'
    echo '/dev/root 19G 6.6G 12G 36% /'
  fi
}
'''


class PrepareProductionDiskTests(unittest.TestCase):
    def run_prepare(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            stubs = directory / "stubs.sh"
            stubs.write_text(STUBS)
            calls = directory / "calls"
            result = subprocess.run(
                ["bash", str(SCRIPT)], capture_output=True, text=True,
                env={**os.environ, "BASH_ENV": str(stubs), "TEST_CALLS": str(calls), **overrides},
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_expands_root_before_image_pull_can_fill_small_partition(self):
        result, calls = self.run_prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "growpart /dev/nvme0n1 1 TMPDIR=/run", "resize2fs /dev/nvme0n1p1",
        ])

    def test_already_grown_partition_still_resizes_filesystem(self):
        result, calls = self.run_prepare(TEST_GROW="full")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("resize2fs /dev/nvme0n1p1", calls)

    def test_growth_failure_is_not_ignored(self):
        result, calls = self.run_prepare(TEST_GROW="error")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("cannot update partition table", result.stdout + result.stderr)

    def test_resize_failure_is_not_ignored(self):
        result, _ = self.run_prepare(TEST_RESIZE_STATUS="1")
        self.assertNotEqual(result.returncode, 0)

    def test_xen_xfs_root(self):
        result, calls = self.run_prepare(TEST_ROOT="/dev/xvda1", TEST_PARENT="xvda", TEST_FS="xfs")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ["growpart /dev/xvda 1 TMPDIR=/run", "xfs_growfs -d /"])

    def test_unpartitioned_root(self):
        result, calls = self.run_prepare(TEST_ROOT="/dev/xvda", TEST_TYPE="disk")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ["resize2fs /dev/xvda"])

    def test_rejects_unsupported_root_without_mutation(self):
        for overrides in [{"TEST_FS": "btrfs"}, {"TEST_TYPE": "lvm"}]:
            with self.subTest(overrides=overrides):
                result, calls = self.run_prepare(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_insufficient_space_fails_with_actionable_message(self):
        result, _ = self.run_prepare(TEST_FREE_KB="5120")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROOT_VOLUME_SIZE", result.stderr)


if __name__ == "__main__":
    unittest.main()
