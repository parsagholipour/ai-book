import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { terminateBrowserProcess } from "./browserProcess.js";

/**
 * The one part of the reclaim that has to be proved against real processes.
 *
 * `browserPoolReclaim.test.ts` mocks this module, because a test may not send
 * real signals to whatever pid a fake browser claims. So the signalling is
 * pinned here instead, against a child that behaves like Chromium does: a
 * process group with children of its own, which a browser leaves behind as
 * renderers when only its leader is killed.
 */

const started: ChildProcess[] = [];

/** A process that will not exit on its own, standing in for a wedged Chromium. */
function spawnIdleChild(options: { detached: boolean }): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: options.detached,
    stdio: "ignore"
  });
  started.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 asks the kernel about the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
  }
});

describe.skipIf(process.platform === "win32")("terminateBrowserProcess", () => {
  it("kills a detached process and everything it spawned", async () => {
    // What puppeteer gives us: Chromium is spawned detached, so its renderers,
    // its GPU process and its zygote share a process group with it. Killing only
    // the leader leaves the rest running on a box that is already out of memory.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);"
        ].join("")
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    started.push(parent);
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      parent.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      parent.once("error", reject);
    });
    expect(isAlive(grandchildPid)).toBe(true);

    expect(terminateBrowserProcess(parent)).toBe("signalled");
    await exited(parent);

    expect(parent.signalCode).toBe("SIGKILL");
    expect(await waitUntilGone(grandchildPid)).toBe(true);
  }, 15_000);

  it("kills a process that is not a group leader without touching anyone else", async () => {
    // A child spawned without `detached` shares this process's group, and the
    // negative pid then names a group that does not exist — which is why the
    // direct kill is the fallback and not the other way round. That this suite
    // goes on running is the assertion that matters.
    const child = spawnIdleChild({ detached: false });

    expect(terminateBrowserProcess(child)).toBe("signalled");
    await exited(child);

    expect(child.signalCode).toBe("SIGKILL");
  }, 15_000);

  it("reports a process that has already exited rather than signalling a recycled pid", async () => {
    // A pid only belongs to our child until it is reaped, which is the moment
    // `exitCode` stops being null. Signalling after that is signalling whoever
    // inherited the number.
    const child = spawnIdleChild({ detached: true });
    child.kill("SIGKILL");
    await exited(child);

    expect(terminateBrowserProcess(child)).toBe("gone");
  }, 15_000);
});
