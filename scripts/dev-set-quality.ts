/**
 * Appends a generation-quality revision that flips one feature for one tier,
 * or swaps one tier's writer or judgment model — for A/B arms:
 *
 *   pnpm exec tsx scripts/dev-set-quality.ts feature chapterEditorPass balanced off
 *   pnpm exec tsx scripts/dev-set-quality.ts model balanced judgment deepseek deepseek-v4-flash thinkingEnabled=false
 *   pnpm exec tsx scripts/dev-set-quality.ts restore <version>      # copy a whole revision's settings back
 */
import { prisma } from "../packages/db/src/index.ts";

const [mode, ...rest] = process.argv.slice(2);
const latest = await prisma.generationQualityRevision.findFirst({ orderBy: { version: "desc" } });
if (!latest) throw new Error("no quality revision");
let settings = structuredClone(latest.settings) as Record<string, unknown> & { models: Record<string, Record<string, unknown>> };
let note = "";
if (mode === "feature") {
  const [feature, tier, state] = rest;
  if (!feature || !tier || !state) throw new Error("usage: feature <id> <tier> on|off");
  const tiers = new Set((settings[feature] as string[] | undefined) ?? []);
  if (state === "on") tiers.add(tier);
  else tiers.delete(tier);
  settings[feature] = [...tiers];
  note = `dev A/B: ${feature} ${state} for ${tier}`;
} else if (mode === "model") {
  const [tier, role, provider, model, ...flags] = rest;
  if (!tier || !role || !provider || !model) throw new Error("usage: model <tier> <writer|judgment> <provider> <model> [key=value...]");
  const selection: Record<string, unknown> = { provider, model };
  for (const flag of flags) {
    const [key, value] = flag.split("=");
    if (key && value !== undefined) selection[key] = value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value;
  }
  settings.models[tier] = { ...settings.models[tier], [role]: selection };
  note = `dev A/B: ${tier}.${role} → ${JSON.stringify(selection)}`;
} else if (mode === "show") {
  const active = await prisma.generationJob.findMany({ where: { status: { in: ["QUEUED", "ACTIVE"] } }, select: { id: true, type: true, projectId: true, status: true } });
  console.log(`revision ${latest.version} (${latest.note ?? ""})`);
  for (const [tier, models] of Object.entries(settings.models)) console.log(`  ${tier}: ${JSON.stringify(models)}`);
  for (const [key, value] of Object.entries(settings)) if (Array.isArray(value)) console.log(`  ${key}: ${JSON.stringify(value)}`);
  console.log(`active jobs: ${JSON.stringify(active)}`);
  await prisma.$disconnect();
  process.exit(0);
} else if (mode === "restore") {
  const source = await prisma.generationQualityRevision.findFirst({ where: { version: Number(rest[0]) } });
  if (!source) throw new Error(`no revision ${rest[0]}`);
  settings = structuredClone(source.settings) as typeof settings;
  note = `dev A/B: restored revision ${rest[0]}`;
} else {
  throw new Error("usage: feature|model|restore|show …");
}
const created = await prisma.generationQualityRevision.create({
  data: { version: latest.version + 1, settings: settings as object, note, updatedBy: "dev-rerun" }
});
console.log(`revision ${created.version}: ${note}`);
await prisma.$disconnect();
process.exit(0);
