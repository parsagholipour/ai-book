root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs, count=1):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:80]); s=s.replace(old,new,count)
    open(root+path,'w').write(s)

TAIL_OLD='"previousChapterTail is the end of the previous chapter, verbatim: continue from it in voice and time without repeating it. earlierChapters are digests of what the reader already knows.",'
TAIL_NEW='''// Composed-8's chapter 8 opened by paraphrasing chapter 7's tail as a coda,
    // and the cut then removed chapter 7's own closing, so three blind readers
    // found the previous chapter's conclusion stranded under the next heading.
    "previousChapterTail is where the previous chapter stopped, already printed: this chapter opens on its own first section's material and neither resumes, summarises nor answers that paragraph. earlierChapters are digests of what the reader already knows; a case one of them carried may be named in passing, never re-told, and its dates and figures are not repeated.",'''
s=open(root+'packages/core/src/generation/composedChapter.ts').read()
assert s.count(TAIL_OLD)==1, s.count(TAIL_OLD)
s=s.replace(TAIL_OLD, TAIL_NEW)
open(root+'packages/core/src/generation/composedChapter.ts','w').write(s)

patch('packages/core/src/generation/authorStance.ts', [
('''  "Also return authorStance, the author this book is written by: thesis (one sentence the whole book argues, or for fiction what the story is about underneath its events), positions (three to five plain assertions the author holds on questions the book raises, each a string stating a fact the author is prepared to defend, with no rejected alternative named),''',
 '''  "Also return authorStance, the author this book is written by: thesis (one sentence the whole book argues about its subject, stated as a fact about the world and never as a rule about how to read evidence, weigh sources or make comparisons — a method is not a thesis, and a writer given one performs it in every paragraph; or for fiction what the story is about underneath its events), positions (three to five plain assertions the author holds about the subject, each a string stating a fact the author is prepared to defend, none of them about method or evidence, with no rejected alternative named),'''),
('''    "thesis: the one claim the whole book argues, in one sentence, stated as a position rather than a topic.",
    "positions: three to five plain assertions the author holds on questions the book raises, each stated as a fact the author is prepared to defend, without naming a rejected alternative.",''',
 '''    "thesis: the one claim the whole book argues about its subject, in one sentence, stated as a fact about the world — never a rule about how to read evidence, weigh sources or make comparisons, which a writer performs in every paragraph.",
    "positions: three to five plain assertions the author holds about the subject, each stated as a fact the author is prepared to defend, none about method or evidence, without naming a rejected alternative.",'''),
])

# harness: --reuse-plan copies a finished plan instead of re-planning
patch('scripts/dev-rerun-book.ts', [
(''' *   pnpm exec tsx scripts/dev-rerun-book.ts run --source <projectId> --label <name> [--baseline <text file>]...''',
 ''' *   pnpm exec tsx scripts/dev-rerun-book.ts run --source <projectId> --label <name> [--reuse-plan <projectId>] [--baseline <text file>]...'''),
('''    if (flag === "--source") args.source = value;''',
 '''    if (flag === "--source") args.source = value;
    else if (flag === "--reuse-plan") args.reusePlan = value;'''),
('''    await queuePlan(projectId, cloned.inputSnapshot);
    await waitForJobs(projectId, ["PLAN_BOOK"], 20 * 60_000);
    await approveLatestPlan(projectId);''',
 '''    if (args.reusePlan) {
      // The same plan as an earlier run, so a comparison measures the writing
      // pipeline rather than a fresh planner's thesis.
      await copyPlan(args.reusePlan, projectId);
    } else {
      await queuePlan(projectId, cloned.inputSnapshot);
      await waitForJobs(projectId, ["PLAN_BOOK"], 20 * 60_000);
    }
    await approveLatestPlan(projectId);'''),
('''async function approveLatestPlan(projectId: string): Promise<string> {''',
 '''async function copyPlan(fromProjectId: string, projectId: string): Promise<void> {
  const source = await prisma.planVersion.findFirst({
    where: { projectId: fromProjectId, status: "APPROVED" },
    orderBy: { version: "desc" }
  });
  if (!source) throw new Error(`Project ${fromProjectId} has no approved plan to reuse`);
  const copy = await prisma.planVersion.create({
    data: {
      projectId,
      version: 1,
      status: "DRAFT",
      planningPackage: source.planningPackage as Prisma.InputJsonValue,
      inputSnapshot: source.inputSnapshot as Prisma.InputJsonValue,
      messages: source.messages as Prisma.InputJsonValue
    }
  });
  await prisma.project.update({ where: { id: projectId }, data: { currentPlanId: copy.id, status: "PLAN_READY" } });
  log(`plan ${source.id} of ${fromProjectId} copied as ${copy.id}`);
}

async function approveLatestPlan(projectId: string): Promise<string> {'''),
])
s=open(root+'scripts/dev-rerun-book.ts').read()
import re
m=re.search(r'type Args = \{([^}]*)\}', s)
assert m
if 'reusePlan' not in m.group(1):
    s=s.replace(m.group(0), m.group(0).replace('source?: string;', 'source?: string;\n  reusePlan?: string;'),1)
    open(root+'scripts/dev-rerun-book.ts','w').write(s)
print("iteration 9 applied")
