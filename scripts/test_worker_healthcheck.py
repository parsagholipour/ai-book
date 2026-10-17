"""Exercise the worker's compose healthcheck against a fake Redis.

The fake speaks just enough RESP for the script's pipelined GETs. The last test
pins the script's key names to the queue names core declares, because the
script cannot import them.
"""
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import threading
import unittest


SCRIPTS = Path(__file__).parent
SCRIPT = SCRIPTS / "worker-healthcheck.sh"
CORE = SCRIPTS.parent / "packages" / "core" / "src"
LONG = "book-maker:worker-heartbeat:book-maker"
INTERACTIVE = "book-maker:worker-heartbeat:book-maker-interactive"
IMAGES = "book-maker:worker-heartbeat:book-maker-images"
COMPILE = "book-maker:worker-heartbeat:book-maker-compile"
BACKGROUND = "book-maker:worker-heartbeat:book-maker-background"
ME = "a1b2c3d4e5f6"


def beat(host, queue):
    # The worker's JSON.stringify(WorkerHeartbeat), field order included.
    return json.dumps({
        "lane": "long", "queue": queue, "pid": 1, "host": host,
        "startedAt": "2026-10-13T10:00:00.000Z", "beatAt": "2026-10-13T10:00:30.000Z",
        "running": 0, "concurrency": 1,
    }, separators=(",", ":"))


class FakeRedis(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, values, error=False):
        self.values = values
        self.error = error
        super().__init__(("127.0.0.1", 0), FakeRedisHandler)


class FakeRedisHandler(socketserver.StreamRequestHandler):
    def handle(self):
        # The script hangs up as soon as one answer fails it.
        try:
            self.serve()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def serve(self):
        while True:
            line = self.rfile.readline()
            if not line:
                return
            count = int(line[1:])
            args = []
            for _ in range(count):
                length = int(self.rfile.readline()[1:])
                args.append(self.rfile.read(length + 2)[:-2].decode())
            if self.server.error:
                self.wfile.write(b"-ERR something went wrong\r\n")
                continue
            assert args[0] == "GET", args
            value = self.server.values.get(args[1])
            if value is None:
                self.wfile.write(b"$-1\r\n")
            else:
                data = value.encode()
                self.wfile.write(b"$%d\r\n%s\r\n" % (len(data), data))


def every_lane(host, **overrides):
    """Every lane's beat from one host; a lane given None is left without one."""
    beats = {
        LONG: beat(host, "book-maker"),
        INTERACTIVE: beat(host, "book-maker-interactive"),
        IMAGES: beat(host, "book-maker-images"),
        COMPILE: beat(host, "book-maker-compile"),
        BACKGROUND: beat(host, "book-maker-background"),
    }
    lanes = {"long": LONG, "interactive": INTERACTIVE, "images": IMAGES, "compile": COMPILE, "background": BACKGROUND}
    for key, value in overrides.items():
        beats[lanes[key]] = value
    return {key: value for key, value in beats.items() if value is not None}


class WorkerHealthcheckTests(unittest.TestCase):
    def check(self, values, error=False, **env):
        server = FakeRedis(values, error)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            result = subprocess.run(
                ["bash", str(SCRIPT)], capture_output=True, text=True, timeout=20,
                env={**os.environ, "HOSTNAME": ME, "REDIS_URL": f"redis://127.0.0.1:{port}", **env},
            )
        finally:
            server.shutdown()
            server.server_close()
        return result

    def test_healthy_while_this_container_beats_on_every_lane(self):
        result = self.check(every_lane(ME))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_lane_without_a_beat_is_unhealthy(self):
        result = self.check(every_lane(ME, interactive=None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(INTERACTIVE, result.stderr)

    def test_a_worker_beating_only_the_two_old_lanes_is_unhealthy(self):
        # A release before the image and compile lanes: its pictures would have no consumer.
        result = self.check(every_lane(ME, images=None, compile=None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(IMAGES, result.stderr)

    def test_a_worker_without_the_background_lane_is_unhealthy(self):
        # /api/ready leaves the lane out, but a release whose background Worker never started is broken.
        result = self.check(every_lane(ME, background=None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(BACKGROUND, result.stderr)

    def test_a_beat_from_the_container_it_replaced_does_not_count(self):
        result = self.check(every_lane(ME, compile=beat("0f0f0f0f0f0f", "book-maker-compile")))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("another worker", result.stderr)

    def test_a_hostname_that_only_prefixes_this_one_does_not_count(self):
        result = self.check(every_lane(ME + "99"))
        self.assertNotEqual(result.returncode, 0)

    def test_a_redis_error_is_unhealthy(self):
        result = self.check({}, error=True)
        self.assertNotEqual(result.returncode, 0)

    def test_an_unreachable_redis_is_unhealthy(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        result = subprocess.run(
            ["bash", str(SCRIPT)], capture_output=True, text=True, timeout=20,
            env={**os.environ, "HOSTNAME": ME, "REDIS_URL": f"redis://127.0.0.1:{port}"},
        )
        self.assertNotEqual(result.returncode, 0)

    def test_a_redis_url_with_credentials_is_refused_rather_than_misread(self):
        result = self.check({}, REDIS_URL="redis://user:secret@redis:6379")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("secret", result.stderr)

    def test_the_keys_are_the_ones_the_worker_writes(self):
        lanes = (CORE / "jobLanes.ts").read_text()
        heartbeat = (CORE / "workerHeartbeat.ts").read_text()
        names = ("LONG_JOB_QUEUE", "INTERACTIVE_JOB_QUEUE", "IMAGE_JOB_QUEUE", "COMPILE_JOB_QUEUE", "BACKGROUND_JOB_QUEUE")
        queues = [re.search(rf'export const {name} = "([^"]+)";', lanes).group(1) for name in names]
        declared = re.search(r"GENERATION_JOB_QUEUES = \[([^\]]*)\]", lanes).group(1)
        self.assertEqual([name.strip() for name in declared.split(",") if name.strip()], list(names))
        prefix = re.search(r"return `([^`$]+)\$\{queue\}`;", heartbeat).group(1)
        expected = [prefix + queue for queue in queues]
        self.assertEqual(expected, [LONG, INTERACTIVE, IMAGES, COMPILE, BACKGROUND])
        named = re.search(r"^keys=\((.*)\)$", SCRIPT.read_text(), re.MULTILINE).group(1).split()
        self.assertEqual(named, expected)
        # And the worker records the hostname this script compares against.
        self.assertIn("options.host ?? hostname()", (SCRIPTS.parent / "apps/worker/src/runtime/workerHeartbeat.ts").read_text())


if __name__ == "__main__":
    unittest.main()
