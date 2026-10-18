"""Run the actual SSM shell payload against disposable release scripts."""
import base64
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "deploy_via_ssm", Path(__file__).with_name("deploy-via-ssm.py")
)
deploy_via_ssm = importlib.util.module_from_spec(spec)
previous_bytecode_setting = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(deploy_via_ssm)
finally:
    sys.dont_write_bytecode = previous_bytecode_setting


class DeployViaSsmTests(unittest.TestCase):
    def run_release(self, install, deploy):
        bundle = io.BytesIO()
        with tarfile.open(fileobj=bundle, mode="w:gz") as archive:
            for name, body in [("install-production-docker.sh", install),
                               ("deploy-production.sh", deploy)]:
                data = body.encode()
                info = tarfile.TarInfo("scripts/" + name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        encoded = base64.b64encode(bundle.getvalue()).decode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "release with spaces"
            command = deploy_via_ssm.deployment_command(str(release), encoded, [])
            result = subprocess.run(["bash", "-c", command], capture_output=True, text=True)
            log = release / "deployment.log"
            return result, log.read_text() if log.exists() else None

    def test_failure_survives_ssm_output_limits_after_verbose_progress(self):
        # SSM returns only the FIRST 24,000 stdout / 8,000 stderr characters.
        # Compose's progress used to fill stderr before the final failure.
        result, log = self.run_release(
            "echo installed\n",
            "head -c 40000 /dev/zero | tr '\\0' x >&2\n"
            "echo 'actual deployment failure' >&2\nexit 7\n",
        )
        self.assertEqual(result.returncode, 7)
        visible = result.stdout[:24000] + result.stderr[:8000]
        self.assertIn("actual deployment failure", visible)
        self.assertLessEqual(len(result.stdout), 24000)
        self.assertIn("installed", log)
        self.assertGreater(len(log), 40000)

    def test_failed_installer_preserves_status_and_never_deploys(self):
        result, log = self.run_release(
            "echo 'installer failed' >&2\nexit 13\n", "echo 'deployment started'\n"
        )
        self.assertEqual(result.returncode, 13)
        self.assertIn("installer failed", result.stdout)
        self.assertNotIn("deployment started", log)

    def test_success_keeps_the_full_private_log_and_reports_success(self):
        result, log = self.run_release("echo installed\n", "echo 'healthy release'\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("healthy release", result.stdout)
        self.assertIn("installed", log)


if __name__ == "__main__":
    unittest.main()
