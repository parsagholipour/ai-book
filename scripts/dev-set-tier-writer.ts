/**
 * Appends a generation-quality revision that swaps one tier's writer model,
 * leaving everything else in the routing row as it is. For model A/B runs:
 *
 *   pnpm exec tsx scripts/dev-set-tier-writer.ts balanced deepseek deepseek-v4-pro
 *   pnpm exec tsx scripts/dev-set-tier-writer.ts balanced gemini gemini-3.7-flash thinkingEffort=medium
 *   pnpm exec tsx scripts/dev-set-tier-writer.ts balanced restore <version>   # copy a revision's writer back
 */
import { prisma } from "../packages/db/src/index.ts";

const [tier, provider, model, ...flags] = process.argv.slice(2);
if (!tier || !provider || !model) {
  console.error("usage: dev-set-tier-writer.ts <tier> <provider> <model> [key=value...] | <tier> restore <version>");
  process.exit(1);
}
const latest = await prisma.generationQualityRevision.findFirst({ orderBy: { version: "desc" } });
if (!latest) throw new Error("no quality revision");
const settings = structuredClone(latest.settings) as { models: Record<string, Record<string, unknown>> };
let writer: Record<string, unknown>;
if (provider === "restore") {
  const source = await prisma.generationQualityRevision.findFirst({ where: { version: Number(model) } });
  if (!source) throw new Error(`no revision ${model}`);
  writer = (source.settings as { models: Record<string, Record<string, unknown>> }).models[tier]!.writer as Record<string, unknown>;
} else {
  writer = { provider, model };
  for (const flag of flags) {
    const [key, value] = flag.split("=");
    if (key && value !== undefined) writer[key] = value === "true" ? true : value === "false" ? false : value;
  }
}
settings.models[tier] = { ...settings.models[tier], writer };
const created = await prisma.generationQualityRevision.create({
  data: {
    version: latest.version + 1,
    settings: settings as object,
    note: `dev A/B: ${tier} writer → ${JSON.stringify(writer)}`,
    updatedBy: "dev-rerun"
  }
});
console.log(`revision ${created.version}: ${tier}.writer = ${JSON.stringify(writer)}`);
await prisma.$disconnect();
process.exit(0);
