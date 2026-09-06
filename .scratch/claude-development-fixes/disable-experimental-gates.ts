import { writeFileSync } from 'node:fs';
import { prisma, Prisma } from '../../packages/db/src/index.ts';
const gates = ['bookDevelopment', 'caseEvidence', 'developmentalEdit'];
try {
  const result = await prisma.$transaction(async tx => {
    const before = await tx.generationQualityRevision.findFirstOrThrow({ orderBy: { version: 'desc' } });
    const settings = structuredClone(before.settings) as Record<string, unknown>;
    for (const gate of gates) settings[gate] = [];
    const after = await tx.generationQualityRevision.create({ data: {
      version: before.version + 1, settings: settings as Prisma.InputJsonObject,
      note: 'Disable the three experimental development gates after completed-book quality and latency regression; retain other settings and model routing.',
      updatedBy: 'codex-quality-regression'
    } });
    return { before, after };
  }, { isolationLevel: 'Serializable' });
  const unchanged = Object.keys(result.before.settings as object).filter(k => !gates.includes(k)).every(k =>
    JSON.stringify((result.before.settings as Record<string, unknown>)[k]) === JSON.stringify((result.after.settings as Record<string, unknown>)[k]));
  if (!unchanged) throw new Error('Unexpected change outside the three gates');
  writeFileSync('docs/composed-chapters/experiments/2026-09-05-fixes/disabled-gates-revision.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ before: result.before.version, after: result.after.version, disabled: gates, otherSettingsUnchanged: unchanged }));
} finally { await prisma.$disconnect(); }
