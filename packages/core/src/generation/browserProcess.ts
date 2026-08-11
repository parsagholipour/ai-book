import type { ChildProcess } from "node:child_process";

/**
 * Signalling the Chromium behind a wedged `browser.close()`.
 *
 * This is the only place in the pool that reaches past puppeteer to the operating
 * system, and it is deliberately one small function: `browserPool.ts` owns the
 * state machine and the deadlines, this owns the platform detail that a test
 * cannot safely execute — sending a real signal to a real process group.
 */

/**
 * What sending the signal amounted to.
 *
 * `"gone"` is the common answer and not a failure: by the time a close has timed
 * out, the process it was waiting on has often exited already. `"unreachable"`
 * means there was nothing to signal — a launch that never produced a process, or
 * a kill the kernel refused — and is the one outcome the caller cannot recover
 * from.
 */
export type BrowserProcessKill = "signalled" | "gone" | "unreachable";

/**
 * Kills the Chromium behind a browser that will not close, and everything it
 * spawned.
 *
 * SIGKILL rather than SIGTERM: a graceful `Browser.close` has already been sent
 * and waited out by the caller, so a second polite request is a second wait for
 * the same answer. Nothing is flushed by a renderer that is already ignoring
 * CDP.
 *
 * The negative pid is the process *group* whose leader has that pid, which on
 * POSIX is Chromium's own — its renderers, its GPU process and its zygote
 * included — because `@puppeteer/browsers` spawns detached there. It cannot name
 * this process's group by accident: a group id is always its leader's pid, and
 * that pid belongs to our child, so a browser that was *not* spawned detached
 * has no group of that id and the call fails with ESRCH rather than reaching
 * anyone else. The direct kill below is the fallback for exactly that case.
 *
 * The exit check above it is not just an optimisation. A pid is only safe to
 * signal for as long as it still belongs to our child, and it does precisely
 * until Node reaps it — which is the same moment `exitCode`/`signalCode` stop
 * being null. Signalling a reaped pid is signalling whoever inherited it.
 *
 * Windows gets the direct kill only. `taskkill /T` is what would take the tree
 * there, and shelling out from `packages/core` to reclaim a process on the one
 * platform this never renders on is not worth the surface.
 */
export function terminateBrowserProcess(child: ChildProcess): BrowserProcessKill {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "gone";
  }
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    return "unreachable";
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return "signalled";
    } catch {
      // Not a group leader, or already gone. Fall through to the direct kill,
      // which answers both.
    }
  }
  try {
    child.kill("SIGKILL");
    return "signalled";
  } catch {
    return "unreachable";
  }
}
