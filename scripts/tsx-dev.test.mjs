import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("dev restart waits for the actual app to stop before starting its replacement", {
  skip: process.platform === "win32", timeout: 30_000
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "book-dev-restart-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const eventsFile = join(dir, "events.jsonl");
  const entry = join(dir, "src", "app.ts");
  const source = `import { appendFileSync } from "node:fs";
const record = (event: string) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({event, pid:process.pid}) + "\\n");
record("started");
setInterval(() => {}, 1000);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  record("stopping");
  setTimeout(() => { record("stopped"); process.exit(0); }, 1500);
});
`;
  await writeFile(entry, source);
  let output = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./tsx-dev.mjs", import.meta.url)), entry], {
    cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEV_WATCH_POLLING: "true" }
  });
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  const events = async () => (await readFile(eventsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const until = async (predicate) => {
    for (let attempts = 0; attempts < 100; attempts++) {
      const rows = await events();
      if (predicate(rows)) return rows;
      await delay(100);
    }
    assert.fail(`App did not reach the expected lifecycle state:\n${output}`);
  };
  await until(rows => rows.some(row => row.event === "started"));
  await delay(300);
  await writeFile(entry, source + "\n// restart\n");
  const rows = await until(rows => rows.filter(row => row.event === "started").length === 2);
  assert.deepEqual(rows.map(row => row.event), ["started", "stopping", "stopped", "started"], output);
  child.kill("SIGTERM");
  await until(rows => rows.filter(row => row.event === "stopped").length === 2);
  await exited;
});
