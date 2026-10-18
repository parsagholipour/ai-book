"""Exercise the production deploy's cutover order and what each failure leaves running.

docker, aws and the host tools are shell functions injected through BASH_ENV,
so nothing here reaches Docker, AWS or /opt. Every call they see is recorded in
order, and S3 is a scratch directory.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("deploy-production.sh")
BUCKET = "book-maker-assets-test"
APP_IMAGE = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/book-maker/app@sha256:new"
WEB_IMAGE = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/book-maker/web@sha256:new"
DUMP = "PGDMP-whole-database"
# What the stubbed `aws ssm get-parameter` writes into the release's .env.
RUNNING_ENV = "POSTGRES_PASSWORD=test\n"
COMPOSE = "name: book-maker\n"
STUBS = r'''
record() { echo "$*" >> "$TEST_CALLS"; }
flock() { :; }
curl() { record "curl $*"; }
free() { :; }
swapon() { echo /swapfile; }
df() {
  if [[ "$*" == *-Pk* ]]; then
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/root 1 1 %s 1%% /\n' "${TEST_FREE_KIB:-20971520}"
  fi
}
aws() {
  case "$1 $2" in
    "ssm get-parameter") echo "POSTGRES_PASSWORD=test" ;;
    "ecr get-login-password") echo token ;;
    "s3 cp")
      local key=${4#s3://$S3_BUCKET/}
      record "aws s3 cp $3 $4"
      if [[ -n ${TEST_UPLOAD_FAILS:-} ]]; then cat > /dev/null; return 1; fi
      mkdir -p "$(dirname "$TEST_S3/$key")"
      cat > "$TEST_S3/$key"
      ;;
    "s3 rm")
      record "aws s3 rm $3"
      rm -f "$TEST_S3/${3#s3://$S3_BUCKET/}"
      ;;
    "s3api head-object")
      local key=$6
      [[ -f $TEST_S3/$key ]] || { echo "An error occurred (404) when calling the HeadObject operation" >&2; return 254; }
      stat -c %s "$TEST_S3/$key"
      ;;
    *) echo "unexpected aws $*" >&2; return 1 ;;
  esac
}
docker() {
  case "$1" in
    login) cat > /dev/null; return 0 ;;
    logout | system) return 0 ;;
    info) echo /var/lib/docker; return 0 ;;
    ps | image) return 0 ;;
    start) record "docker start $2"; return 0 ;;
    compose) shift ;;
    *) echo "unexpected docker $*" >&2; return 1 ;;
  esac
  while [[ $1 == --env-file || $1 == -f ]]; do shift 2; done
  case "$1" in
    config | pull) return 0 ;;
    ps)
      # `ps --quiet --status running <service>` and `ps --all --quiet <service>`:
      # the running release's containers are "<service>-old".
      local service=${!#}
      if [[ $service == --* || $service == ps ]]; then return 0; fi
      if [[ "$*" == *--status* && " ${TEST_RUNNING-api worker web} " != *" $service "* ]]; then return 0; fi
      echo "$service-old"
      return 0
      ;;
    exec)
      if [[ "$*" == *pg_dump* ]]; then
        record "compose exec pg_dump"
        if [[ -n ${TEST_DUMP_FAILS:-} ]]; then printf 'PGDMP-part'; return 1; fi
        printf '%s' "$TEST_DUMP"
      fi
      return 0
      ;;
  esac
  case "$*" in
    "up -d --no-deps --wait --wait-timeout 120 web") record "compose $* with $WEB_IMAGE" ;;
    *) record "compose $*" ;;
  esac
  case "$*" in
    "run --rm --no-deps api"*) [[ -z ${TEST_PREFLIGHT_FAILS:-} ]] ;;
    "run --rm --no-deps migrate") [[ -z ${TEST_MIGRATE_FAILS:-} ]] ;;
    "up -d --no-deps --wait --wait-timeout 240 api worker web") [[ -z ${TEST_NEW_RELEASE_UNHEALTHY:-} ]] ;;
    "up -d --no-deps --wait --wait-timeout 120 web") [[ -z ${TEST_NEW_WEB_UNHEALTHY:-} || $WEB_IMAGE != *@sha256:new ]] ;;
    *) return 0 ;;
  esac
}
'''


class DeployProductionTests(unittest.TestCase):
    def deploy(self, *, running_app="old-app", running_env=None, running_compose=COMPOSE,
               unsettled=False, **overrides):
        """Deploy over a running release ("old") that ran `running_app` beside the
        .env and compose file given (None: that file is absent)."""
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            root = directory / "opt"
            old = root / "releases" / "old"
            new = root / "releases" / "new"
            old.mkdir(parents=True)
            new.mkdir(parents=True)
            (old / "images.env").write_text(f"APP_IMAGE={running_app}\nWEB_IMAGE=old-web\n")
            if running_env is not None:
                (old / ".env").write_text(running_env)
            if running_compose is not None:
                (old / "docker-compose.production.yml").write_text(running_compose)
            (new / "docker-compose.production.yml").write_text(COMPOSE)
            (root / "current").symlink_to(old)
            if unsettled:
                (root / "cutover-incomplete").touch()
            s3 = directory / "s3"
            s3.mkdir()
            stubs = directory / "stubs.sh"
            stubs.write_text(STUBS)
            calls = directory / "calls"
            env = {
                **os.environ,
                "BASH_ENV": str(stubs),
                "TEST_CALLS": str(calls),
                "TEST_S3": str(s3),
                "TEST_DUMP": DUMP,
                "BOOK_MAKER_ROOT": str(root),
                "BOOK_MAKER_DEPLOY_LOCK": str(directory / "deploy.lock"),
                **overrides,
            }
            result = subprocess.run(
                ["bash", str(SCRIPT), "eu-central-1", "/book-maker/production/env", APP_IMAGE, WEB_IMAGE, BUCKET],
                capture_output=True, text=True, env=env, cwd=new,
            )
            objects = {
                str(path.relative_to(s3)): path.read_text()
                for path in s3.rglob("*") if path.is_file()
            }
            return {
                "result": result,
                "calls": calls.read_text().splitlines() if calls.exists() else [],
                "objects": objects,
                "current": os.readlink(root / "current"),
                "previous": os.readlink(root / "previous") if (root / "previous").is_symlink() else None,
                "unsettled": (root / "cutover-incomplete").exists(),
                "dump_note": (new / "database-dump").read_text() if (new / "database-dump").exists() else None,
                "new": str(new),
                "old": str(old),
            }

    def index(self, calls, prefix):
        matches = [i for i, call in enumerate(calls) if call.startswith(prefix)]
        self.assertEqual(len(matches), 1, f"expected one call starting {prefix!r} in {calls}")
        return matches[0]

    def test_the_worker_drains_alone_then_the_dump_precedes_the_migration(self):
        run = self.deploy()
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        calls = run["calls"]
        order = [
            self.index(calls, "compose run --rm --no-deps api node"),
            self.index(calls, "compose stop worker"),
            self.index(calls, "compose stop api web"),
            self.index(calls, "compose up -d --wait --wait-timeout 180 postgres redis"),
            self.index(calls, "compose run --rm --no-deps migrate"),
            self.index(calls, "compose up -d --no-deps --wait --wait-timeout 240 api worker web"),
            self.index(calls, "curl "),
        ]
        self.assertEqual(order, sorted(order), calls)
        # The two ends of the dump's pipe record in either order, both between
        # the databases coming up and the migration.
        for end in ("compose exec pg_dump", "aws s3 cp - s3://"):
            self.assertTrue(order[3] < self.index(calls, end) < order[4], calls)
        # The dump is whole, under the dedicated prefix, named by time and release.
        [(key, body)] = run["objects"].items()
        self.assertRegex(key, r"^db-backups/\d{8}T\d{6}Z-new\.dump$")
        self.assertEqual(body, DUMP)
        self.assertEqual(run["dump_note"], f"s3://{BUCKET}/{key}\n")
        self.assertEqual(run["current"], run["new"])
        self.assertFalse(run["unsettled"])
        self.assertFalse(any(call.startswith("docker start") for call in calls), calls)

    def test_a_refused_preflight_stops_nothing(self):
        run = self.deploy(TEST_PREFLIGHT_FAILS="1")
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertFalse(any(call.startswith(("compose stop", "docker start")) for call in run["calls"]), run["calls"])
        self.assertEqual(run["objects"], {})
        self.assertEqual(run["current"], run["old"])

    def test_a_failed_dump_restarts_the_running_release_and_migrates_nothing(self):
        run = self.deploy(TEST_DUMP_FAILS="1")
        calls = run["calls"]
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertNotIn("compose run --rm --no-deps migrate", calls)
        # The partial object the pipe uploaded is removed, never left as a backup.
        self.assertTrue(any(call.startswith("aws s3 rm s3://") for call in calls), calls)
        self.assertEqual(run["objects"], {})
        self.assertIsNone(run["dump_note"])
        starts = [call for call in calls if call.startswith("docker start")]
        self.assertEqual(starts, ["docker start api-old", "docker start worker-old", "docker start web-old"])
        self.assertIn("Nothing was migrated", run["result"].stderr)
        self.assertEqual(run["current"], run["old"])

    def test_a_failed_upload_restarts_the_running_release(self):
        run = self.deploy(TEST_UPLOAD_FAILS="1")
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertNotIn("compose run --rm --no-deps migrate", run["calls"])
        self.assertEqual(run["objects"], {})
        self.assertEqual(len([c for c in run["calls"] if c.startswith("docker start")]), 3, run["calls"])

    def test_only_what_was_running_is_started_again(self):
        run = self.deploy(TEST_DUMP_FAILS="1", TEST_RUNNING="api web")
        starts = [call for call in run["calls"] if call.startswith("docker start")]
        self.assertEqual(starts, ["docker start api-old", "docker start web-old"])

    def test_a_failed_migration_leaves_everything_stopped_and_names_the_dump(self):
        run = self.deploy(TEST_MIGRATE_FAILS="1")
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertFalse(any(call.startswith("docker start") for call in run["calls"]), run["calls"])
        [key] = run["objects"]
        self.assertIn(f"s3://{BUCKET}/{key}", run["result"].stderr)
        self.assertIn("Restoring the database before a release", run["result"].stderr)
        self.assertEqual(run["current"], run["old"])
        # The API and worker are stopped, so the next release may not trust them.
        self.assertTrue(run["unsettled"])

    def test_an_unhealthy_new_release_is_not_rolled_back_onto_a_migrated_schema(self):
        run = self.deploy(TEST_NEW_RELEASE_UNHEALTHY="1")
        self.assertNotEqual(run["result"].returncode, 0)
        self.assertFalse(any(call.startswith("docker start") for call in run["calls"]), run["calls"])
        self.assertIn("left stopped", run["result"].stderr)
        self.assertEqual(run["current"], run["old"])


    # The running release ran this app image beside this .env and compose file.
    WEB_ONLY = {"running_app": APP_IMAGE, "running_env": RUNNING_ENV}

    def test_a_release_that_changes_only_web_replaces_web_alone(self):
        run = self.deploy(**self.WEB_ONLY)
        self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
        calls = run["calls"]
        order = [
            self.index(calls, "compose run --rm --no-deps api node"),
            self.index(calls, f"compose up -d --no-deps --wait --wait-timeout 120 web with {WEB_IMAGE}"),
            self.index(calls, "compose up -d --no-deps --wait --wait-timeout 120 caddy"),
            self.index(calls, "curl "),
        ]
        self.assertEqual(order, sorted(order), calls)
        for skipped in ("compose stop", "compose up -d --wait --wait-timeout 180 postgres redis",
                        "compose exec pg_dump", "compose run --rm --no-deps migrate",
                        "compose up -d --no-deps --wait --wait-timeout 240", "docker start"):
            self.assertFalse(any(call.startswith(skipped) for call in calls), (skipped, calls))
        self.assertEqual(run["objects"], {})
        self.assertIsNone(run["dump_note"])
        self.assertEqual(run["current"], run["new"])
        self.assertEqual(run["previous"], run["old"])

    def test_anything_the_running_release_cannot_vouch_for_takes_the_full_cutover(self):
        cases = {
            "a new app image": {"running_app": "old-app"},
            "a changed environment": {"running_env": "POSTGRES_PASSWORD=old\n"},
            "no recorded environment": {"running_env": None},
            "a changed compose file": {"running_compose": "name: book-maker\nservices: {}\n"},
            "no recorded compose file": {"running_compose": None},
            "a stopped API": {"TEST_RUNNING": "worker web"},
            "a stopped worker": {"TEST_RUNNING": "api web"},
            "a cutover that failed partway": {"unsettled": True},
        }
        for name, change in cases.items():
            with self.subTest(name):
                run = self.deploy(**{**self.WEB_ONLY, **change})
                self.assertEqual(run["result"].returncode, 0, run["result"].stderr)
                self.index(run["calls"], "compose stop worker")
                self.index(run["calls"], "compose run --rm --no-deps migrate")
                self.index(run["calls"], "compose up -d --no-deps --wait --wait-timeout 240 api worker web")
                self.assertFalse(run["unsettled"])

    def test_a_failed_web_only_release_puts_the_running_web_back(self):
        run = self.deploy(**self.WEB_ONLY, TEST_NEW_WEB_UNHEALTHY="1")
        self.assertNotEqual(run["result"].returncode, 0)
        web = [call for call in run["calls"] if call.startswith("compose up -d --no-deps --wait --wait-timeout 120 web")]
        self.assertEqual(web, [
            f"compose up -d --no-deps --wait --wait-timeout 120 web with {WEB_IMAGE}",
            "compose up -d --no-deps --wait --wait-timeout 120 web with old-web",
        ])
        self.assertFalse(any(call.startswith(("compose stop", "docker start")) for call in run["calls"]), run["calls"])
        self.assertIn("Starting the running release's web again", run["result"].stderr)
        self.assertEqual(run["current"], run["old"])
        self.assertFalse(run["unsettled"])


if __name__ == "__main__":
    unittest.main()
