/**
 * Print the latest plan of a project the way the candidate-5 inspection reads it:
 * chapter index, title, targetPages, the sum, generic-fallback titles, and the stance.
 *
 *   pnpm exec tsx docs/composed-chapters/experiments/2026-09-06-fresh-plan/inspect-plan.ts <projectId> [<out.json>]
 */
import { writeFileSync } from "node:fs";
import { prisma } from "../../../../packages/db/src/index.ts";

const projectId = process.argv[2];
if (!projectId) throw new Error("project id required");
try {
  const plan = await prisma.planVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!plan) throw new Error(`no plan on ${projectId}`);
  const pkg = plan.planningPackage as {
    title?: string;
    chapters?: Array<{ index: number; title: string; targetPages: number; summary?: string; keyBeats?: string[] }>;
    authorStance?: { thesis?: string; positions?: string[]; refusals?: string[]; voiceSample?: string };
    promises?: string[];
    openingHook?: string;
    writingMode?: string;
  };
  const chapters = pkg.chapters ?? [];
  const generic = chapters.filter((chapter) => /^Chapter \d+: (Opening|Development|Perspective|Resolution)$/.test(chapter.title));
  console.log(JSON.stringify({
    planId: plan.id,
    version: plan.version,
    status: plan.status,
    title: pkg.title,
    writingMode: pkg.writingMode,
    chapterCount: chapters.length,
    pageSum: chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0),
    genericTitles: generic.length,
    targets: chapters.map((chapter) => chapter.targetPages),
    chapters: chapters.map((chapter) => `${chapter.index}. ${chapter.title} (${chapter.targetPages}p)`),
    thesis: pkg.authorStance?.thesis,
    positions: pkg.authorStance?.positions?.length,
    refusals: pkg.authorStance?.refusals?.length,
    voiceSampleWords: (pkg.authorStance?.voiceSample ?? "").split(/\s+/).filter(Boolean).length,
    promises: pkg.promises?.length,
    openingHook: pkg.openingHook
  }, null, 2));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(plan.planningPackage, null, 2));
} finally {
  await prisma.$disconnect();
}
