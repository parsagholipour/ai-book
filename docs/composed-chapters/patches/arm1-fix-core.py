"""Arm-1 fixes after developer-review-arm1.md (A1–A12). Idempotent."""
import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def rd(p): return open(root+p).read()
def wr(p,s): open(root+p,'w').write(s)
def patch(path, pairs):
    s=rd(path)
    for old,new in pairs:
        if new in s: continue
        assert old in s, (path, old[:90]); s=s.replace(old,new,1)
    wr(path,s)

# ---------- core: bookArc.ts ----------
p='packages/core/src/generation/bookArc.ts'; s=rd(p)
if 'export type ArchitectResult' not in s:
    # (c) applyBookArcPages with a deterministic page repair
    start=s.index('/**\n * The plan with the arc\'s page cut applied')
    end=s.index('\n}\n', s.index('export function applyBookArcPages'))+3
    s=s[:start]+'''export const MIN_ARC_CHAPTER_PAGES = 3;
export const MAX_ARC_CHAPTER_PAGES = 14;

/**
 * The arc's pages made to sum to the book: scaled, rounded, and the residual
 * moved one page at a time onto the largest chapters, within the floor and
 * ceiling a chapter may have. Models miss the sum routinely, and dropping the
 * cut for it would drop the one axis the arc exists to test.
 */
export function repairArcPages(pages: readonly number[], targetPages: number): number[] | undefined {
  const count = pages.length;
  if (count === 0 || targetPages < count) return undefined;
  const floor = Math.max(1, Math.min(MIN_ARC_CHAPTER_PAGES, Math.floor(targetPages / count)));
  const ceiling = Math.max(MAX_ARC_CHAPTER_PAGES, Math.ceil(targetPages / count));
  const sum = pages.reduce((total, value) => total + Math.max(0, value), 0) || count;
  const repaired = pages.map((value) => Math.min(ceiling, Math.max(floor, Math.round((Math.max(0, value) || 1) * (targetPages / sum)))));
  let residual = targetPages - repaired.reduce((total, value) => total + value, 0);
  let guard = 0;
  while (residual !== 0 && guard++ < 20 * count) {
    const order = repaired.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
    const target = order.find((entry) => (residual > 0 ? entry.value < ceiling : entry.value > floor));
    if (!target) return undefined;
    repaired[target.index] = repaired[target.index]! + (residual > 0 ? 1 : -1);
    residual += residual > 0 ? -1 : 1;
  }
  return repaired;
}

/**
 * The plan with the arc's page cut applied, when the arc covers every chapter
 * once: a cut whose pages do not sum to the book is repaired
 * (`repairArcPages`) and the repaired arc returned beside the plan, so what is
 * persisted is what the rows were cut to. Only an arc that does not match the
 * plan's chapters keeps the plan's own targets.
 */
export function applyBookArcPages(
  plan: BookPlan,
  arc: BookArc,
  targetPages: number
): { plan: BookPlan; arc: BookArc; applied: boolean; reason?: string } {
  const byIndex = new Map(arc.chapters.map((chapter) => [chapter.index, chapter]));
  if (byIndex.size !== plan.chapters.length || plan.chapters.some((chapter) => !byIndex.has(chapter.index))) {
    return { plan, arc, applied: false, reason: "arc chapters do not match the plan's" };
  }
  const ordered = plan.chapters.map((chapter) => byIndex.get(chapter.index)!);
  const requested = ordered.map((chapter) => chapter.pages);
  const sum = requested.reduce((total, value) => total + value, 0);
  const pages = sum === targetPages ? requested : repairArcPages(requested, targetPages);
  if (!pages) {
    return { plan, arc, applied: false, reason: `arc pages sum to ${sum}, the book has ${targetPages}, and no repair fits` };
  }
  const repairedArc: BookArc = {
    ...arc,
    chapters: arc.chapters.map((chapter) => {
      const position = plan.chapters.findIndex((entry) => entry.index === chapter.index);
      return position >= 0 ? { ...chapter, pages: pages[position]! } : chapter;
    })
  };
  return {
    plan: { ...plan, chapters: plan.chapters.map((chapter, position) => ({ ...chapter, targetPages: pages[position]! })) },
    arc: repairedArc,
    applied: true,
    ...(sum === targetPages ? {} : { reason: `arc pages summed to ${sum} for a ${targetPages}-page book; scaled and rounded` })
  };
}
'''+s[end:]
    # (a) arcChapterLines
    start=s.index('/** The lines a chapter\'s writer sees from the arc')
    end=s.index('export async function architectBook')
    s=s[:start]+'''const ANSWER_OVERLAP_WORDS = 4;

function contentWordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z\\u00C0-\\u024F]{4,}/g) ?? []);
}

/** Whether a prompt line shares enough content words with the answer to be the answer in other words. */
export function sharesAnswer(line: string, answer: string): boolean {
  const answerWords = contentWordSet(answer);
  let shared = 0;
  for (const word of contentWordSet(line)) if (answerWords.has(word)) shared += 1;
  return shared >= ANSWER_OVERLAP_WORDS;
}

/** The chapter after the turn that repairs it: the first whose job says so, else the next one. */
export function repairChapterIndex(arc: BookArc): number | undefined {
  if (!arc.turn) return undefined;
  const after = arc.chapters.filter((chapter) => chapter.index > arc.turn!.chapterIndex).sort((a, b) => a.index - b.index);
  return (after.find((chapter) => /^\\s*repair/i.test(chapter.job.does)) ?? after[0])?.index;
}

/**
 * The lines a chapter's writer sees from the arc: its own job and kind, the
 * opponent where the chapter argues with it, the turn where it happens — and
 * never the book's answer. Every chapter but the resolution is also filtered:
 * a job line that shares four content words with the answer is the answer in
 * other words (`believesSoFar` after the turn, typically) and is dropped.
 */
export function arcChapterLines(arc: BookArc, chapterIndex: number): string[] {
  const chapter = arc.chapters.find((entry) => entry.index === chapterIndex);
  if (!chapter) {
    return [];
  }
  const indexes = arc.chapters.map((entry) => entry.index);
  const last = Math.max(...indexes);
  const first = Math.min(...indexes);
  const resolution = chapter.kind === "resolution";
  const fixed: string[] = [`The book asks: ${arc.question}`, KIND_RULES[chapter.kind]];
  const filtered: string[] = [];
  const job = chapter.job;
  if (job.believesSoFar) filtered.push(`What the reader believes by now: ${job.believesSoFar}`);
  if (job.does) filtered.push(`What this chapter does: ${job.does}`);
  if (job.adds) filtered.push(`What it adds that no other chapter adds: ${job.adds}`);
  if (job.leavesOpen && chapterIndex !== last) filtered.push(`What it leaves open, for the next chapter to take up: ${job.leavesOpen}`);
  if (chapter.cast.length > 0) filtered.push(`People this chapter carries: ${chapter.cast.join("; ")}.`);
  if (chapter.dispute && (chapter.dispute.sideA.name || chapter.dispute.sideB.name)) {
    filtered.push(
      `The dispute in this chapter: ${chapter.dispute.sideA.name} holds that ${chapter.dispute.sideA.claim}; ${chapter.dispute.sideB.name} holds that ${chapter.dispute.sideB.claim}; at stake: ${chapter.dispute.atStake}. Argue it by name.`
    );
  }
  const opponent = arc.opponent;
  if (opponent?.name && (chapterIndex === first || chapter.kind === "argument" || resolution)) {
    const named = `${opponent.name}${opponent.work ? `, ${opponent.work}` : ""}${opponent.year ? ` (${opponent.year})` : ""}`;
    filtered.push(
      `The opponent the book argues with, by name: ${named}: ${opponent.claim}${opponent.whereRight ? ` Where they are right: ${opponent.whereRight}` : ""}${
        resolution && opponent.whereTheBookBreaks ? ` Where the book breaks with them: ${opponent.whereTheBookBreaks}` : ""
      }`
    );
  }
  if (arc.turn?.trouble && arc.turn.chapterIndex === chapterIndex) {
    filtered.push(`This is the chapter where the book's own answer runs into trouble: ${arc.turn.trouble} Let the trouble stand; nothing here repairs it.`);
  } else if (arc.turn?.repair && repairChapterIndex(arc) === chapterIndex) {
    filtered.push(`This chapter repairs the trouble the chapter before it raised: ${arc.turn.repair}`);
  }
  if (resolution) {
    return [...fixed, ...filtered];
  }
  return [
    ...fixed,
    ...filtered.filter((line) => !sharesAnswer(line, arc.answer)),
    "Do not state the book's answer; this chapter is one step toward it, and the reader should finish it wanting the next."
  ];
}

export type ArchitectResult = { arc?: BookArc | undefined; failure?: string | undefined };

'''+s[end:]
    # (b) architectBook: result object, no proposal, smaller budget
    s=s.replace('''}): Promise<BookArc | undefined> {
  const targetPages = options.input.targetPages;''','''}): Promise<ArchitectResult> {
  const targetPages = options.input.targetPages;''',1)
    s=s.replace('      maxTokens: 14000,\n      schema: bookArcSchema,','      maxTokens: 8000,\n      schema: bookArcSchema,',1)
    s=s.replace('"Return one JSON object with question, opponent, answer, turn, chapters and proposal, shaped exactly like outputContract.",','"Return one JSON object with question, opponent, answer, turn and chapters, shaped exactly like outputContract.",',1)
    s=re.sub(r'\n\s*"proposal: three to four thousand words of prose[^\n]*\n','\n',s,count=1)
    s=re.sub(r',\n\s*proposal: "Three to four thousand words\."\n','\n',s,count=1)
    s=s.replace('    return result.data;\n  } catch (error) {\n    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {\n      throw error;\n    }\n    return undefined;\n  }','    return { arc: result.data };\n  } catch (error) {\n    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {\n      throw error;\n    }\n    return { failure: error instanceof Error ? error.message : String(error) };\n  }',1)
    assert 'return { arc: result.data };' in s, 'architect return'
    # (d) document kind quotes only what the notes carry
    s=s.replace('it reads one text closely, quoting its own words where they carry the weight, and ends on the document.','it reads one text closely, quoting only words that appear verbatim in researchNotes and paraphrasing the rest, and ends on the document.',1)
    wr(p,s)

# ---------- core: chapterIntegrity.ts exports the Latin set ----------
patch('packages/core/src/generation/chapterIntegrity.ts', [('const LATIN_SCRIPT_LANGUAGES = new Set([','export const LATIN_SCRIPT_LANGUAGES = new Set([')])

# ---------- core: seams.ts ----------
patch('packages/core/src/generation/seams.ts', [
('import { generateJsonWithRetry } from "./generateJsonWithRetry.js";','import { isStopOrAbortError } from "../adapters/retry.js";\nimport { LATIN_SCRIPT_LANGUAGES } from "./chapterIntegrity.js";\nimport { generateJsonWithRetry } from "./generateJsonWithRetry.js";'),
('''export const SEAM_SIMILARITY_CEILING = 0.5;
''','''export const SEAM_SIMILARITY_CEILING = 0.5;

/** The acceptance reads Latin proper nouns and words, so only a Latin-script book gets seams rewritten. */
export function seamsSupported(language: string): boolean {
  return LATIN_SCRIPT_LANGUAGES.has(language);
}
'''),
('''}): Promise<{ replacements: SeamReplacement[]; accepted: number; rejected: number }> {
  if (options.chapters.length === 0) {
    return { replacements: [], accepted: 0, rejected: 0 };
  }
  const arcByIndex = new Map(options.arc?.chapters.map((chapter) => [chapter.index, chapter]) ?? []);
  const result = await generateJsonWithRetry(options.textModel, {''','''}): Promise<{ replacements: SeamReplacement[]; accepted: number; rejected: number; skipped?: string }> {
  if (options.chapters.length === 0) {
    return { replacements: [], accepted: 0, rejected: 0 };
  }
  const arcByIndex = new Map(options.arc?.chapters.map((chapter) => [chapter.index, chapter]) ?? []);
  // The seams are a revision, never prose the book cannot ship without: a
  // provider failure here is a skipped revision, not a failed book, the same
  // rule the manuscript read follows. A cancellation still propagates.
  let result: { data: z.infer<typeof seamsSchema> };
  try {
    result = await generateJsonWithRetry(options.textModel, {'''),
('''      }
    ]
  });
  const replacements: SeamReplacement[] = [];''','''      }
    ]
  });
  } catch (error) {
    if (isStopOrAbortError(error)) {
      throw error;
    }
    return { replacements: [], accepted: 0, rejected: 0, skipped: `seams failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const replacements: SeamReplacement[] = [];'''),
('''  const paragraphs = markdown.split(/\\n\\s*\\n/);
  if (paragraphs.length === 0) return markdown;''','''  const paragraphs = markdown.split(/\\n\\s*\\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length === 0) return markdown;'''),
])

# ---------- core: chapterForms.ts ----------
patch('packages/core/src/generation/chapterForms.ts', [
('''  /** The arc's kind for this chapter, when the book has an arc. */
  kind?: string | undefined;
};''','''  /** The arc's kind for this chapter, when the book has an arc. */
  kind?: string | undefined;
  /** The arc's job for this chapter (`job.does`), which stands in for the plan's summary. */
  job?: string | undefined;
};'''),
('''                ...(range.kind ? { kind: range.kind } : {})
              })),''','''                ...(range.kind ? { kind: range.kind } : {}),
                ...(range.job ? { job: range.job } : {})
              })),'''),
('''                summary: range.chapter.summary,
                keyBeats: range.chapter.keyBeats,''','''                // Under an arc the job stands in for the summary: the plan's summary says what the chapter proves.
                summary: range.job ?? range.chapter.summary,
                keyBeats: range.chapter.keyBeats,'''),
])

# ---------- core: composedChapter.ts ----------
patch('packages/core/src/generation/composedChapter.ts', [
('''function bookPayload(plan: BookPlan, input: CreateProjectInput) {
  return {
    title: plan.title,
    premise: plan.premise,''','''/**
 * The book as the writer sees it. Under an arc, a middle chapter gets the
 * book's question for its premise and no promises: composed-7's premise *is*
 * the thesis, and the promises say where the book lands, so the stance lines
 * withholding the answer were being handed it back one key over.
 */
function bookPayload(plan: BookPlan, input: CreateProjectInput, withheld: BookArc | undefined) {
  return {
    title: plan.title,
    premise: withheld ? withheld.question : plan.premise,'''),
('''    styleNotes: plan.voiceGuide,
    continuityRules: plan.continuityRules,
    promises: plan.promises
  };
}''','''    styleNotes: plan.voiceGuide,
    continuityRules: plan.continuityRules,
    ...(withheld ? {} : { promises: plan.promises })
  };
}

/** The arc, when this chapter is one the answer is withheld from. */
function withheldArc(options: ComposeChapterOptions): BookArc | undefined {
  return options.arc && !isFirstOrLastChapter(options) ? options.arc : undefined;
}

/** The chapter's summary as the writer sees it: the arc's job where the plan's summary would say what the chapter proves. */
function chapterSummaryFor(options: ComposeChapterOptions): string {
  const arc = withheldArc(options);
  const job = arc?.chapters.find((entry) => entry.index === options.chapter.index)?.job.does;
  return job || options.chapter.summary;
}'''),
('''    book: bookPayload(options.plan, options.input),
    chapter: {
      index: options.chapter.index,
      title: options.chapter.title,
      summary: options.chapter.summary
    },''','''    book: bookPayload(options.plan, options.input, withheldArc(options)),
    chapter: {
      index: options.chapter.index,
      title: options.chapter.title,
      summary: chapterSummaryFor(options)
    },'''),
('''  stopsDevelopingAt: z.number().int().positive().optional(),
  swappable: z.array(z.number().int().positive()).max(2).optional()''','''  stopsDevelopingAt: z.number().int().positive().optional(),
  swappable: z.array(z.number().int().positive()).max(2).optional(),
  answerStatedIn: z.array(z.number().int().positive()).default([])'''),
('''  stance: AuthorStance;
  chapters: ManuscriptChapterForRead[];
  textModel: TextModelAdapter;
}): Promise<ManuscriptReadResult> {''','''  stance: AuthorStance;
  /** The arc, when the book has one: the read then reports where the answer was stated early. */
  arc?: BookArc | undefined;
  chapters: ManuscriptChapterForRead[];
  textModel: TextModelAdapter;
}): Promise<ManuscriptReadResult> {'''),
('''          `The author's stance, which the chapters should honour: ${options.stance.thesis} Positions: ${options.stance.positions.join(" | ")}`,
          ...(isNarrativeWritingMode(mode) ? ["This is fiction: judge scenes, not arguments."] : []),''','''          `The author's stance, which the chapters should honour: ${options.stance.thesis} Positions: ${options.stance.positions.join(" | ")}`,
          ...(options.arc
            ? [
                `The book's answer, which only its resolution chapter (chapter ${Math.max(...options.arc.chapters.map((chapter) => chapter.index))}) may state: ${options.arc.answer} Return answerStatedIn: every chapter index before it whose prose states that answer in its own words, or an empty array.`
              ]
            : []),
          ...(isNarrativeWritingMode(mode) ? ["This is fiction: judge scenes, not arguments."] : []),'''),
('''              bookNotes: ["One observation about the whole book."]
            }''','''              bookNotes: ["One observation about the whole book."],
              stopsDevelopingAt: 1,
              swappable: [],
              answerStatedIn: []
            }'''),
('''    ...(result.data.swappable !== undefined ? { swappable: result.data.swappable } : {})
  };
}''','''    ...(result.data.swappable !== undefined ? { swappable: result.data.swappable } : {}),
    ...(result.data.answerStatedIn.length > 0 ? { answerStatedIn: result.data.answerStatedIn } : {})
  };
}'''),
])
s=rd('packages/core/src/generation/composedChapter.ts')
if 'answerStatedIn?: number[] | undefined;' not in s:
    s=s.replace('  swappable?: number[] | undefined;','  swappable?: number[] | undefined;\n  /** Chapters before the resolution whose prose states the arc\'s answer, per the read. */\n  answerStatedIn?: number[] | undefined;',1)
    wr('packages/core/src/generation/composedChapter.ts', s)
print("core patched")
