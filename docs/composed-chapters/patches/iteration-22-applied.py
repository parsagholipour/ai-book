import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:80]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)

# A. research: every chapter searched, the brief kept, sources capped per query
patch('packages/core/src/generation/planner.ts', [
('''  const uniqueQueries = uniqueStrings(queries).slice(0, cap);
  const results = await Promise.allSettled(
    uniqueQueries.map((query) => options.research.search({ query, purpose: "chapter-research" }))
  );

  return results
    .flatMap((result) => {
      if (result.status !== "fulfilled") {
        return [];
      }
      return result.value.sources.map((source) => ({
        query: result.value.query,
        title: source.title,
        url: source.url,
        summary: source.summary,
        publishedAt: source.publishedAt
      }));
    })
    .slice(0, cap);
}''',
 '''  // Every chapter is searched, and the cap bounds the sources kept *per
  // query*. It used to cap the query list and then the flattened result list
  // at the same number, so a 15-chapter book searched 12 chapters and kept 12
  // sources — all from chapter 1's query — and every chapter's writer received
  // the same twelve dictionary snippets while the search's own synthesised
  // brief for each query was dropped on the floor (composed-7..21).
  const uniqueQueries = uniqueStrings(queries);
  const perQuery = Math.max(3, Math.min(RESEARCH_SOURCES_PER_QUERY, cap));
  const results = await Promise.allSettled(
    uniqueQueries.map((query) => options.research.search({ query, purpose: "chapter-research" }))
  );

  return results.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }
    const brief = result.value.summary?.trim();
    return [
      // The brief first: what the search concluded across its sources, kept
      // without a URL so it grounds the writer but is never cited as a source.
      ...(brief ? [{ query: result.value.query, title: RESEARCH_BRIEF_TITLE, url: undefined, summary: brief, publishedAt: undefined }] : []),
      ...result.value.sources.slice(0, perQuery).map((source) => ({
        query: result.value.query,
        title: source.title,
        url: source.url,
        summary: source.summary,
        publishedAt: source.publishedAt
      }))
    ];
  });
}

/** Sources kept per chapter query; a search returns 20–30 and the writer reads about a dozen notes. */
export const RESEARCH_SOURCES_PER_QUERY = 8;
/** The title of a query's synthesised brief row; it has no URL and is context, not a citation. */
export const RESEARCH_BRIEF_TITLE = "Research brief";'''),
])

# loader: with a chapter to match, read the whole project's rows and put the brief first
patch('apps/worker/src/generation/generationContext.ts', [
('''    prisma.researchSource.findMany({
      where: { projectId, url: { not: null } },
      orderBy: { createdAt: "desc" },
      // Semantic hits may point beyond the recency window; load the URL-backed
      // identity set needed to validate those hits, then return only topK.
      ...(semantic ? {} : { take })
    })''',
 '''    prisma.researchSource.findMany({
      // With a chapter to match against, every row of the project is read:
      // each chapter's query stored its own brief and sources, and a recency
      // window over ~150 rows (with createMany's one timestamp) is arbitrary.
      where: chapter ? { projectId } : { projectId, url: { not: null } },
      orderBy: { createdAt: "desc" },
      // Semantic hits may point beyond the recency window; load the URL-backed
      // identity set needed to validate those hits, then return only topK.
      ...(semantic || chapter ? {} : { take })
    })'''),
('''  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  const matching = sources
    .filter((source) => hasSharedSearchTerm(chapterTerms, `${source.query} ${source.title} ${source.summary}`))
    .map((source) => `${source.title}: ${source.summary}`);''',
 '''  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  const matching = storedSources
    .filter((source) => hasSharedSearchTerm(chapterTerms, `${source.query} ${source.title} ${source.summary}`))
    // The query's own brief before its sources.
    .sort((a, b) => Number(b.title === "Research brief") - Number(a.title === "Research brief"))
    .map((source) => `${source.title}: ${source.summary}`);'''),
])

# B. form plan: section counts and shares vary; the writer sees each section's words
patch('packages/core/src/generation/chapterForms.ts', [
('''    const opening = forms[0];''',
 '''    const shares = composition.sections.map((section) => section.share);
    if (shares.length >= 3 && Math.max(...shares) - Math.min(...shares) < 0.08) {
      issues.push(`Chapter ${composition.chapterIndex} splits its length evenly across sections; give it one section of at least 40% and one under 15%.`);
    }
    const opening = forms[0];'''),
('''  for (const [form, count] of bookCounts) {''',
 '''  // Fifteen chapters of exactly four sections at exactly a quarter each was
  // the best-scoring balanced book's form plan (composed-19a); the readers
  // called every chapter the same silhouette.
  if (compositions.length >= 6) {
    const counts = new Set(compositions.map((composition) => composition.sections.length));
    if (counts.size === 1) {
      issues.push(`Every chapter has ${[...counts][0]} sections; vary the count across the book within each chapter's sectionCount range.`);
    }
  }
  for (const [form, count] of bookCounts) {'''),
('''            "Section counts per chapter are given as sectionCount; shares are fractions of the chapter's length and sum to 1.",''',
 '''            "Section counts per chapter are given as sectionCount; shares are fractions of the chapter's length and sum to 1. Vary the count from chapter to chapter across that range, and give every chapter one section that takes at least 40% of its length and one that takes under 15%, so no two chapters have the same silhouette.",'''),
])
s=open(root+'packages/core/src/generation/chapterForms.ts').read()
m=re.search(r'export function compositionWriterLines\(\s*composition: ChapterComposition,\s*palette: readonly SectionForm\[\]\s*\): string\[\] \{', s)
assert m, "compositionWriterLines signature"
s=s.replace(m.group(0), 'export function compositionWriterLines(\n  composition: ChapterComposition,\n  palette: readonly SectionForm[],\n  targetWords?: number\n): string[] {',1)
old='''    return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"}): ${section.subject}.${owns}${note}`;'''
new='''    const length = targetWords ? ` About ${Math.max(120, Math.round(section.share * targetWords))} words.` : "";
    return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"}): ${section.subject}.${owns}${note}${length}`;'''
assert old in s; s=s.replace(old,new,1)
open(root+'packages/core/src/generation/chapterForms.ts','w').write(s)

# C. compose/edit prompts: stable block first so the prefix caches; chapter-specific lines last
p=root+'packages/core/src/generation/composedChapter.ts'; s=open(p).read()
old='''  const systemLines = [
    `Write chapter ${options.chapter.index}, "${options.chapter.title}", of the book "${options.plan.title}" as its author, as one continuous piece of finished Markdown prose.`,
    ...stanceLinesFor(options),
    "Paragraphs only: no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.",
    ...compositionWriterLines(options.composition, palette),
    ...(minimal ? [] : shapeRules(narrative)),'''
new='''  // Stable lines first (the same for every chapter of a book), chapter lines
  // last: OpenAI caches an identical prompt prefix past ~1k tokens, and with
  // the chapter line first none of a book's 30 prose calls ever hit it.
  const systemLines = [
    `You are writing the book "${options.plan.title}" as its author, one chapter at a time, each as one continuous piece of finished Markdown prose.`,
    ...stanceLinesFor(options),
    "Paragraphs only: no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.",
    ...(minimal ? [] : shapeRules(narrative)),'''
assert old in s; s=s.replace(old,new,1)
old='''    ...(minimal ? [] : ["Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\")."]),
    ...(minimal ? [] : reconstructionRule(narrative)),
    ...(options.variant === "second"'''
new='''    ...(minimal ? [] : ["Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\")."]),
    ...(minimal ? [] : reconstructionRule(narrative)),
    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...compositionWriterLines(options.composition, palette, budget.target),
    ...(options.variant === "second"'''
assert old in s; s=s.replace(old,new,1)
# edit prompt: same reorder
old='''    `You are the line editor for "${options.plan.title}". Revise chapter ${options.chapter.index}, "${options.chapter.title}", into its finished form, in the author's own voice.`,
    ...stanceLinesFor(options),
    ...compositionWriterLines(options.composition, palette),
    "Keep every fact, name, date, number, place and quotation'''
new='''    `You are the line editor for "${options.plan.title}", revising each chapter into its finished form in the author's own voice.`,
    ...stanceLinesFor(options),
    "Keep every fact, name, date, number, place and quotation'''
assert old in s; s=s.replace(old,new,1)
old='''    ...(options.measurementNotes && options.measurementNotes.length > 0
      ? [`Measured on this draft, with the sentences that put each measure over its ceiling; rewrite those sentences and bring every measure under: ${options.measurementNotes.join(" || ")}`]
      : []),'''
new='''    `Now chapter ${options.chapter.index}, "${options.chapter.title}".`,
    ...compositionWriterLines(options.composition, palette, budget.target),
    ...(options.measurementNotes && options.measurementNotes.length > 0
      ? [`Measured on this draft, with the sentences that put each measure over its ceiling; rewrite those sentences and bring every measure under: ${options.measurementNotes.join(" || ")}`]
      : []),'''
assert old in s; s=s.replace(old,new,1)
open(p,'w').write(s)

# D. harness: --stance-positions <json file> rewrites the copied plan's positions
patch('scripts/dev-rerun-book.ts', [
('''    else if (flag === "--tier") args.tier = value;''',
 '''    else if (flag === "--tier") args.tier = value;
    else if (flag === "--stance-positions") args.stancePositions = value;'''),
('''  tier?: string | undefined;''', '''  tier?: string | undefined;
  stancePositions?: string | undefined;'''),
('''async function copyPlan(fromProjectId: string, projectId: string, tier?: string): Promise<void> {''',
 '''async function copyPlan(fromProjectId: string, projectId: string, tier?: string, stancePositions?: string): Promise<void> {'''),
('''      planningPackage: source.planningPackage as Prisma.InputJsonValue,''',
 '''      planningPackage: (stancePositions
        ? (() => {
            const pkg = structuredClone(source.planningPackage) as { authorStance?: { positions?: string[] } };
            const positions = JSON.parse(readFileSync(stancePositions, "utf8")) as string[];
            if (pkg.authorStance) pkg.authorStance.positions = positions;
            log(`stance positions replaced (${positions.length})`);
            return pkg;
          })()
        : source.planningPackage) as Prisma.InputJsonValue,'''),
('''      await copyPlan(args.reusePlan, projectId, args.tier);''', '''      await copyPlan(args.reusePlan, projectId, args.tier, args.stancePositions);'''),
])
s=open(root+'scripts/dev-rerun-book.ts').read()
if 'readFileSync' not in s.split('\n', 40)[0:40].__str__():
    s=s.replace('import { mkdirSync, writeFileSync } from "node:fs";','import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',1)
open(root+'scripts/dev-rerun-book.ts','w').write(s)
print("iteration 22 applied")
