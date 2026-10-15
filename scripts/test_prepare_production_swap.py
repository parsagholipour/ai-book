"""Exercise swap preparation: create it once, never touch an active swapfile."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("prepare-production-swap.sh")
GIB = 1024 * 1024 * 1024
STUBS = r'''
id() { echo "${TEST_UID:-0}"; }
sysctl() { echo "sysctl $*" >> "$TEST_CALLS"; }
swapon() {
  if [[ "$*" == *--show* ]]; then
    if [[ "$*" == *NAME* ]]; then printf '%s' "${TEST_ACTIVE:-}"; fi
    return 0
  fi
  echo "swapon $*" >> "$TEST_CALLS"
}
mkswap() { echo "mkswap $*" >> "$TEST_CALLS"; }
dd() {
  local arg out
  for arg in "$@"; do
    case "$arg" in of=*) out=${arg#of=} ;; esac
  done
  echo "dd $*" >> "$TEST_CALLS"
  printf 'swap' > "$out"
}
df() {
  # Validate the actual GNU df options before returning synthetic free space.
  command df "$@" >/dev/null || return
  printf 'Avail\n%s\n' "${TEST_FREE_KB:-12582912}"
}
free() { :; }
'''


class PrepareProductionSwapTests(unittest.TestCase):
    def run_prepare(self, fstab="", existing=None, **overrides):
        """Run the script against a scratch swapfile, fstab and sysctl file.

        "{swapfile}" in `fstab` and in any override stands for the scratch
        swapfile's path, and is put back in what comes out.
        """
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            swapfile = directory / "swapfile"
            fill = lambda text: text.replace("{swapfile}", str(swapfile))
            unfill = lambda text: text.replace(str(swapfile), "{swapfile}")
            stubs = directory / "stubs.sh"
            stubs.write_text(STUBS)
            calls = directory / "calls"
            fstab_path = directory / "fstab"
            fstab_path.write_text(fill(fstab))
            sysctl_conf = directory / "90-book-maker-swap.conf"
            if existing is not None:
                swapfile.write_bytes(b"")
                os.truncate(swapfile, existing)  # sparse: no real disk used
            env = {
                **os.environ,
                "BASH_ENV": str(stubs),
                "TEST_CALLS": str(calls),
                "BOOK_MAKER_SWAPFILE": str(swapfile),
                "BOOK_MAKER_FSTAB": str(fstab_path),
                "BOOK_MAKER_SYSCTL_CONF": str(sysctl_conf),
                **{key: fill(value) for key, value in overrides.items()},
            }
            result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)
            return {
                "result": result,
                "stdout": unfill(result.stdout),
                "calls": [unfill(line) for line in (calls.read_text().splitlines() if calls.exists() else [])],
                "fstab": unfill(fstab_path.read_text()),
                "sysctl": sysctl_conf.read_text() if sysctl_conf.exists() else None,
                "swapfile_mode": swapfile.stat().st_mode & 0o777 if swapfile.exists() else None,
                "partial_left": swapfile.with_name("swapfile.partial").exists(),
            }

    def test_fresh_host_gets_a_persistent_swapfile_and_low_swappiness(self):
        run = self.run_prepare(fstab="UUID=abc / ext4 defaults 0 1\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["calls"], [
            "sysctl -q -w vm.swappiness=10",
            "dd if=/dev/zero of={swapfile}.partial bs=1M count=2048 status=none",
            "mkswap {swapfile}.partial",
            "swapon {swapfile}",
        ])
        self.assertEqual(run["fstab"], "UUID=abc / ext4 defaults 0 1\n{swapfile} none swap sw 0 0\n")
        self.assertIn("vm.swappiness = 10", run["sysctl"])
        self.assertEqual(run["swapfile_mode"], 0o600)
        self.assertFalse(run["partial_left"])

    def test_rerun_leaves_an_active_swapfile_and_its_fstab_line_alone(self):
        fstab = "UUID=abc / ext4 defaults 0 1\n{swapfile} none swap sw 0 0\n"
        run = self.run_prepare(fstab=fstab, existing=2 * GIB, TEST_ACTIVE="{swapfile}\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["calls"], ["sysctl -q -w vm.swappiness=10"])
        self.assertEqual(run["fstab"], fstab)
        self.assertIn("{swapfile} is already active", run["stdout"])

    def test_an_fstab_line_spelled_differently_still_counts(self):
        fstab = "/dev/root / ext4 defaults 0 1\n{swapfile} swap swap defaults 0 0\n"
        run = self.run_prepare(fstab=fstab, existing=2 * GIB, TEST_ACTIVE="{swapfile}\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["fstab"], fstab)

    def test_active_swapfile_missing_from_fstab_is_persisted(self):
        run = self.run_prepare(existing=2 * GIB, TEST_ACTIVE="/dev/zram0\n{swapfile}\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["calls"], ["sysctl -q -w vm.swappiness=10"])
        self.assertEqual(run["fstab"], "{swapfile} none swap sw 0 0\n")

    def test_active_swapfile_of_another_size_is_reported_not_resized(self):
        run = self.run_prepare(existing=1 * GIB, TEST_ACTIVE="{swapfile}\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["calls"], ["sysctl -q -w vm.swappiness=10"])
        self.assertIn("active at 1024 MiB, not 2048 MiB", run["stdout"])

    def test_inactive_leftover_is_rebuilt(self):
        run = self.run_prepare(existing=512, TEST_ACTIVE="/dev/zram0\n")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["calls"][1:], [
            "dd if=/dev/zero of={swapfile}.partial bs=1M count=2048 status=none",
            "mkswap {swapfile}.partial",
            "swapon {swapfile}",
        ])

    def test_fstab_without_trailing_newline_gets_its_own_line(self):
        run = self.run_prepare(fstab="UUID=abc / ext4 defaults 0 1")
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        self.assertEqual(run["fstab"], "UUID=abc / ext4 defaults 0 1\n{swapfile} none swap sw 0 0\n")

    def test_refuses_to_eat_the_deploys_pull_room(self):
        # 5 GiB free: the swapfile would leave 3 GiB, under the deploy's 4 GiB floor.
        run = self.run_prepare(TEST_FREE_KB=str(5 * 1024 * 1024))
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertIn("ROOT_VOLUME_SIZE", run["result"].stderr)
        self.assertEqual(run["calls"], ["sysctl -q -w vm.swappiness=10"])
        self.assertEqual(run["fstab"], "")

    def test_requires_root(self):
        run = self.run_prepare(TEST_UID="1000")
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertEqual(run["calls"], [])
        self.assertIsNone(run["sysctl"])


if __name__ == "__main__":
    unittest.main()
