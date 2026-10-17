/**
 * Print the selection each variant spec resolves to per tier and purpose (no provider call).
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/probe-route.ts \
 *     --tiers balanced,fast --purposes compose-chapter,edit-chapter --variants baseline,baseline+model=gemini:gemini-3.7-flash
 */
import { parseArgs } from "../lib/args.ts";
import { parseVariant } from "../variants/index.ts";
import { resolveSelection } from "./runtime.ts";

const args = parseArgs(process.argv.slice(2));
const tiers = args.list("tiers").length ? args.list("tiers") : ["balanced", "fast"];
const purposes = args.list("purposes").length ? args.list("purposes") : ["compose-chapter"];
const specs = args.list("variants").length ? args.list("variants") : ["baseline"];
for (const tier of tiers) {
  for (const purpose of purposes) {
    for (const spec of specs) {
      const selection = await resolveSelection(tier, purpose, parseVariant(spec).route);
      console.log([tier, purpose, spec, JSON.stringify(selection)].join("\t"));
    }
  }
}
process.exit(0);
