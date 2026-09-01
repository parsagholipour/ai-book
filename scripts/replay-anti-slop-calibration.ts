/**
 * Periodic offline evaluation for the anti-slop distilled corpus.
 *
 * Replays `replayAntiSlopCalibration` (Phase 01–05 fixtures) and prints a JSON
 * report. Never reads `storage/` or live books. Exit 1 if any fixture fails.
 *
 *   pnpm anti-slop:replay
 *
 * Full manuscripts stay local-only: pass caller-supplied pages to
 * `replayDeterministicManuscriptChecks` in a one-off script; do not point this
 * command at production storage.
 */

import {
  formatAntiSlopCalibrationCli,
  replayAntiSlopCalibration
} from "../packages/core/src/generation/antiSlopCalibration.js";

const report = await replayAntiSlopCalibration();
const cli = formatAntiSlopCalibrationCli(report);
console.log(JSON.stringify(cli, null, 2));
if (!cli.ok) {
  process.exitCode = 1;
}
