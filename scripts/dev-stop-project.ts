/**
 * Stops every queued or active generation job of a project the way the
 * mobile stop route does, for books the rerun harness started:
 *
 *   pnpm exec tsx scripts/dev-stop-project.ts <projectId>
 */
import { stopProjectGenerationJobs } from "../apps/api/src/queue.ts";

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: dev-stop-project.ts <projectId>");
  process.exit(1);
}
const result = await stopProjectGenerationJobs(projectId);
console.log(JSON.stringify(result).slice(0, 600));
process.exit(0);
