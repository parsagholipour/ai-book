/**
 * The deploy's preflight: `node --import tsx src/checkProductionConfig.ts`,
 * run in the *new* app image against the release's `.env`
 * (`scripts/deploy-production.sh`, and `scripts/check-production-docker.sh`
 * in CI) before anything is stopped.
 *
 * The API and worker make the same check at boot, but by then the deploy has
 * already stopped the release that was serving, so a missing setting would be
 * an outage. Here it is a failed deploy with the old release still up. It asks
 * both processes' rules regardless of NODE_ENV, prints names and never values,
 * and exits 1 on any problem. The saved Quality-tab routing is not read here
 * (that needs the database); the API warns about it at boot.
 */
import {
  formatProductionConfigProblems,
  loadConfig,
  MOCK_AI_IN_PRODUCTION_MESSAGE,
  productionConfigReport,
  type ProductionConfigIssue
} from "@book-maker/core";

const config = loadConfig();
const reports = [productionConfigReport(config, "api"), productionConfigReport(config, "worker")];

function unique(issues: ProductionConfigIssue[]): ProductionConfigIssue[] {
  return [...new Map(issues.map((issue) => [issue.message, issue])).values()];
}

const problems = unique(reports.flatMap((report) => report.problems));
const warnings = unique(reports.flatMap((report) => report.warnings));

if (config.NODE_ENV === "production" && config.MOCK_AI) {
  console.error(MOCK_AI_IN_PRODUCTION_MESSAGE);
}
for (const warning of warnings) {
  console.warn(`warning: ${warning.message}`);
}
if (problems.length > 0) {
  console.error(formatProductionConfigProblems("release", problems));
  process.exit(1);
}
console.log("Production configuration: every required setting is present.");
