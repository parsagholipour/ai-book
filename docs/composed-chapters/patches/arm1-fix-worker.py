"""Arm-1 fixes, worker half + tests. Idempotent."""
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

# ---------- state ----------
patch('apps/worker/src/generation/composedChaptersState.ts', [
('''max: number
  /** The seams call replaced this chapter's opening and/or closing. */
  seamsApplied?: boolean | undefined;
};''','''max: number };'''),
('''  /** The seams call replaced this chapter's opening and/or closing. */
  seamsApplied?: boolean | undefined;
  formPlanSource:''','''  /** The seams call replaced this chapter's opening and/or closing. */
  seamsApplied?: boolean | undefined;
  /** Where the book's arc came from: stored on the plan, or planned by this run. */
  arc?: "stored" | "model" | undefined;
  /** What the manuscript read said about the whole book, kept on the first chapter's report. */
  readMetrics?: { stopsDevelopingAt?: number | undefined; swappable?: number[] | undefined; answerStatedIn?: number[] | undefined } | undefined;
  formPlanSource:'''),
])

# ---------- pass ----------
p='apps/worker/src/generation/composedChaptersPass.ts'; s=rd(p)
old_block='''  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance");
  let stance = planAuthorStance(plan);
  // The book's arc: planned once per book and stored on the plan, so a resumed
  // run re-cuts the same pages; without an arc the pass runs as before.
  let arc = planBookArc(plan);
  if (!arc && BOOK_ARC) {
    arc = await architectBook({ input, plan, stance: stance ?? { thesis: "", positions: [], refusals: [], voiceSample: "" }, textModel });
    if (arc) await persistBookArc(planId, arc);
  }
  if (arc) {
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    if (cut.applied) {
      plan = cut.plan;
    } else {
      console.warn("Book arc page cut not applied", { event: "generation.composed_chapters.arc_pages_not_applied", projectId, reason: cut.reason });
    }
  }
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
  }

'''
new_block='''  await advanceJobStep(generationJobId, "briefs", 12, "Deciding the author's stance");
  let stance = planAuthorStance(plan);
  if (!stance) {
    stance = await generateAuthorStance({ input, plan, textModel });
    await persistGeneratedAuthorStance(planId, stance);
  }
  // The book's arc: planned once per book and stored on the plan together
  // with its page cut, so a resumed run re-cuts the same pages; without an arc
  // the pass runs as before. It comes before the chapter setups because the
  // Chapter rows, the form plan and the word budgets are all derived from the
  // cut — computed after them it reached only the prompts (developer review,
  // 2026-09-03).
  let arc = planBookArc(plan);
  let arcSource: "stored" | "model" | undefined = arc ? "stored" : undefined;
  if (!arc && BOOK_ARC) {
    await updateJobProgress(generationJobId, { progress: 13, message: "Planning the book's arc" });
    const architected = await architectBook({ input, plan, stance, textModel });
    if (architected.arc) {
      arc = architected.arc;
      arcSource = "model";
    } else {
      console.warn("Book arc not produced; composing without one", {
        event: "generation.composed_chapters.arc_not_produced",
        projectId,
        reason: architected.failure
      });
    }
  }
  if (arc) {
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    if (cut.applied) {
      plan = cut.plan;
      arc = cut.arc;
      if (cut.reason) {
        console.warn("Book arc page cut repaired", { event: "generation.composed_chapters.arc_pages_repaired", projectId, reason: cut.reason });
      }
    } else {
      console.warn("Book arc page cut not applied", { event: "generation.composed_chapters.arc_pages_not_applied", projectId, reason: cut.reason });
    }
    if (arcSource === "model") {
      await persistBookArc(planId, arc, cut.applied ? cut.plan.chapters : undefined);
    }
  }

'''
if old_block in s:
    s=s.replace(old_block,'',1)
    anchor='  const quality = await loadQualityContext(input);\n'
    assert anchor in s; s=s.replace(anchor, anchor+new_block,1)
assert 'let arcSource' in s
# persistBookArc
old_persist_start=s.index('async function persistBookArc(')
old_persist_end=s.index('\n}\n', old_persist_start)+3
s=s[:old_persist_start]+'''async function persistBookArc(planId: string, arc: BookArc, chapters: BookPlan["chapters"] | undefined): Promise<void> {
  try {
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    // A stored arc that parses stands; one that does not is repaired here,
    // or every retry would re-architect, never persist, and resume "fresh".
    if (!row || !isRecord(row.planningPackage) || bookArcSchema.safeParse(row.planningPackage.bookArc).success) {
      return;
    }
    // The cut rides with the arc: the compile places chapter headings by the
    // stored plan's targetPages, so rows cut one way under a plan cut another
    // print headings mid-chapter.
    await prisma.planVersion.update({
      where: { id: planId },
      data: {
        planningPackage: { ...row.planningPackage, bookArc: arc, ...(chapters ? { chapters } : {}) } as unknown as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    console.warn("Book arc was not persisted onto the plan", { event: "generation.composed_chapters.arc_not_persisted", planId, error });
  }
}
'''+s[old_persist_end:]
wr(p,s)
patch(p, [
('''    stance,
    ranges: setups.map((setup) => {
      const kind = arc?.chapters.find((entry) => entry.index === setup.chapter.index)?.kind;
      return { chapter: setup.chapter, startPage: setup.startPage, endPage: setup.endPage, ...(kind ? { kind } : {}) };
    }),''','''    // Under an arc the form planner sees the question and never the answer:
    // its subjects and notes reach the writer.
    stance: arc ? { ...stance, thesis: arc.question, positions: [] } : stance,
    ranges: setups.map((setup) => {
      const arcChapter = arc?.chapters.find((entry) => entry.index === setup.chapter.index);
      return {
        chapter: setup.chapter,
        startPage: setup.startPage,
        endPage: setup.endPage,
        ...(arcChapter ? { kind: arcChapter.kind } : {}),
        ...(arcChapter?.job.does ? { job: arcChapter.job.does } : {})
      };
    }),'''),
('''      paragraphCv: 0,
      shapePassApplied: false
    };
  };''','''      paragraphCv: 0,
      shapePassApplied: false,
      ...(arcSource ? { arc: arcSource } : {})
    };
  };'''),
('''    const read = await readManuscript({ input, plan, stance, chapters: chaptersForRead, textModel });
    if (read.skipped) {
      console.warn("Manuscript read skipped", { event: "generation.composed_chapters.read_skipped", projectId, reason: read.skipped });
    }''','''    const read = await readManuscript({ input, plan, stance, ...(arc ? { arc } : {}), chapters: chaptersForRead, textModel });
    if (read.skipped) {
      console.warn("Manuscript read skipped", { event: "generation.composed_chapters.read_skipped", projectId, reason: read.skipped });
    }
    if (read.stopsDevelopingAt !== undefined || read.swappable !== undefined || read.answerStatedIn !== undefined) {
      const readMetrics = {
        ...(read.stopsDevelopingAt !== undefined ? { stopsDevelopingAt: read.stopsDevelopingAt } : {}),
        ...(read.swappable !== undefined ? { swappable: read.swappable } : {}),
        ...(read.answerStatedIn !== undefined ? { answerStatedIn: read.answerStatedIn } : {})
      };
      console.warn("Manuscript read metrics", { event: "generation.composed_chapters.read_metrics", projectId, ...readMetrics });
      const firstIndex = setups[0]?.chapter.index;
      const firstReport = firstIndex === undefined ? undefined : reports.get(firstIndex);
      if (firstIndex !== undefined && firstReport) {
        reports.set(firstIndex, { ...firstReport, readMetrics });
      }
    }'''),
('''    if (SEAMS_TOGETHER && arc) {
      await rewriteSeamsTogether(arc, read.bookNotes);
    }
    const flagged = read.chapters.filter(''','''    const flagged = read.chapters.filter('''),
('''      digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    }
  }

  await finalizePendingPages(''','''      digests.set(setup.chapter.index, chapterDigest(pages.map((page) => page.summary)));
    }
    // The seams come after the cuts: the read's notes quote the pre-seam
    // paragraphs, so a closing replaced first would leave a cut nothing to
    // find, or take away the paragraph the seams had just bought.
    if (SEAMS_TOGETHER && arc && seamsSupported(input.language)) {
      await rewriteSeamsTogether(arc, read.bookNotes);
    }
  }

  await finalizePendingPages('''),
('''      const seams = await rewriteSeams({ input, plan, arc: bookArc, chapters: seamChapters, bookNotes, textModel });
      console.warn("Seams rewritten", { event: "generation.composed_chapters.seams", projectId, accepted: seams.accepted, rejected: seams.rejected });
      for (const replacement of seams.replacements) {
        const setup = setups.find((candidate) => candidate.chapter.index === replacement.index);
        const chapterId = setup ? chapterIds.get(setup.chapter.index) : undefined;
        const current = setup ? finalText.get(setup.chapter.index) : undefined;
        if (!setup || !chapterId || !current) continue;
        const seamed = applySeam(current, replacement);
        if (seamed === current) continue;
        const pages = await describePages(setup, seamed);
        const previous''','''      const seams = await rewriteSeams({ input, plan, arc: bookArc, chapters: seamChapters, bookNotes, textModel });
      if (seams.skipped) {
        console.warn("Seams skipped", { event: "generation.composed_chapters.seams_skipped", projectId, reason: seams.skipped });
        return;
      }
      console.warn("Seams rewritten", { event: "generation.composed_chapters.seams", projectId, accepted: seams.accepted, rejected: seams.rejected });
      // The re-describes are independent, so they run three at a time; the
      // staging after them is sequential because it writes page rows.
      const described = await mapWithConcurrency(seams.replacements, 3, async (replacement) => {
        const setup = setups.find((candidate) => candidate.chapter.index === replacement.index);
        const chapterId = setup ? chapterIds.get(setup.chapter.index) : undefined;
        const current = setup ? finalText.get(setup.chapter.index) : undefined;
        if (!setup || !chapterId || !current) return undefined;
        const seamed = applySeam(current, replacement);
        if (seamed === current) return undefined;
        return { setup, chapterId, current, seamed, pages: await describePages(setup, seamed) };
      });
      for (const entry of described) {
        if (!entry) continue;
        const { setup, chapterId, current, seamed, pages } = entry;
        const previous'''),
])
s=rd(p)
m=re.search(r'import \{([^}]*)\} from "@book-maker/core";', s)
need=['bookArcSchema','mapWithConcurrency','seamsSupported']
add=[n for n in need if re.search(r'\b'+n+r'\b', m.group(1)) is None]
if add:
    s=s.replace(m.group(0), 'import {'+m.group(1).rstrip()+',\n  '+',\n  '.join(add)+'\n} from "@book-maker/core";',1)
wr(p,s)

# ---------- tests ----------
wr('packages/core/src/generation/bookArc.test.ts', '''import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import {
  applyBookArcPages,
  arcChapterLines,
  architectBook,
  bookArcSchema,
  planBookArc,
  repairArcPages,
  repairChapterIndex,
  sharesAnswer
} from "./bookArc.js";

const input = {
  prompt: "A comparative history of aggression",
  category: "EDUCATION",
  targetPages: 24,
  temperature: 0.4,
  language: "en",
  mediaSettings: { illustrationCadence: "none" }
} as unknown as CreateProjectInput;

function fourChapterPlan() {
  return {
    ...makeFallbackPlan(input),
    chapters: [1, 2, 3, 4].map((index) => ({ index, title: `Chapter ${index}`, summary: `Summary ${index}`, keyBeats: [], targetPages: 6 }))
  };
}

const arcFixture = {
  question: "Whether organised violence follows temperament or offices?",
  opponent: { name: "Steven Pinker", work: "The Better Angels of Our Nature", year: 2011, claim: "Violence declined as states grew.", whereRight: "The counts are real.", whereTheBookBreaks: "The counts measure offices, not temperament." },
  answer: "Offices give organised violence its reach and its targets.",
  turn: { chapterIndex: 2, trouble: "A crowd kills without an office.", repair: "The committee is the office." },
  chapters: [
    { index: 1, kind: "method", pages: 5, job: { believesSoFar: "", does: "establish: how a trace becomes a claim.", adds: "The method.", leavesOpen: "Whether offices matter." }, cast: ["Aelius"] },
    { index: 2, kind: "complication", pages: 7, job: { believesSoFar: "That offices give organised violence its reach and targets.", does: "complicate: the crowd.", adds: "The crowd.", leavesOpen: "Who organised it." }, cast: [] },
    { index: 3, kind: "argument", pages: 6, job: { believesSoFar: "That crowds organise themselves.", does: "repair: the committee as an office.", adds: "The committee.", leavesOpen: "" }, cast: [] },
    { index: 4, kind: "resolution", pages: 6, job: { believesSoFar: "", does: "resolve: the answer through one last case.", adds: "", leavesOpen: "" }, cast: [] }
  ]
};

describe("book arc", () => {
  it("is produced by the architect call, re-cuts the pages and gives each chapter its own lines", async () => {
    const plan = fourChapterPlan();
    const stance = { thesis: "T", positions: ["P1", "P2"], refusals: [], voiceSample: "V" };
    const { arc } = await architectBook({ input, plan, stance, textModel: new FakeTextModelAdapter(input) });
    expect(arc).toBeDefined();
    expect(arc!.chapters).toHaveLength(plan.chapters.length);
    const cut = applyBookArcPages(plan, arc!, input.targetPages);
    expect(cut.applied).toBe(true);
    expect(cut.plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
    const middle = plan.chapters[1]!.index;
    const lines = arcChapterLines(arc!, middle).join(" ");
    expect(lines).toContain("What this chapter does");
    expect(lines).toContain("Do not state the book's answer");
    expect(lines).not.toContain(arc!.answer);
    expect(arcChapterLines(arc!, plan.chapters.at(-1)!.index).join(" ")).toContain("resolution");
  });

  it("repairs a cut that does not sum to the book and keeps every chapter within the floor and ceiling", () => {
    expect(repairArcPages([8, 8, 8, 8], 24)).toEqual([6, 6, 6, 6]);
    expect(repairArcPages([10, 3, 3, 3], 24)).toEqual([12, 4, 4, 4]);
    expect(repairArcPages([20, 20, 20, 20], 120)!.reduce((a, b) => a + b, 0)).toBe(120);
    expect(repairArcPages([1, 1], 1)).toBeUndefined();
    const plan = fourChapterPlan();
    const arc = bookArcSchema.parse({ ...arcFixture, chapters: arcFixture.chapters.map((chapter) => ({ ...chapter, pages: chapter.pages + 1 })) });
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    expect(cut.applied).toBe(true);
    expect(cut.reason).toContain("scaled");
    expect(cut.plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
    expect(cut.arc.chapters.map((chapter) => chapter.pages)).toEqual(cut.plan.chapters.map((chapter) => chapter.targetPages));
    const wrongChapters = bookArcSchema.parse({ ...arcFixture, chapters: arcFixture.chapters.slice(0, 2) });
    expect(applyBookArcPages(plan, wrongChapters, input.targetPages).applied).toBe(false);
  });

  it("shows the opponent to the first, the argument and the resolution chapters, and the turn to its chapter and the repair", () => {
    const arc = bookArcSchema.parse(arcFixture);
    expect(arc.chapters[0]!.kind).toBe("method");
    const first = arcChapterLines(arc, 1).join(" ");
    const turn = arcChapterLines(arc, 2).join(" ");
    const argument = arcChapterLines(arc, 3).join(" ");
    const resolution = arcChapterLines(arc, 4).join(" ");
    expect(first).toContain("Steven Pinker, The Better Angels of Our Nature (2011)");
    expect(first).not.toContain("Where the book breaks with them");
    expect(turn).not.toContain("Steven Pinker");
    expect(turn).toContain("runs into trouble: A crowd kills without an office.");
    expect(argument).toContain("Steven Pinker");
    expect(argument).toContain("repairs the trouble");
    expect(repairChapterIndex(arc)).toBe(3);
    expect(resolution).toContain("Where the book breaks with them");
    expect(resolution).not.toContain("Do not state the book's answer");
  });

  it("drops a middle chapter's line that is the answer in other words, and never the question", () => {
    const arc = bookArcSchema.parse(arcFixture);
    expect(sharesAnswer("That offices give organised violence its reach and targets.", arc.answer)).toBe(true);
    expect(sharesAnswer("complicate: the crowd.", arc.answer)).toBe(false);
    const turn = arcChapterLines(arc, 2);
    expect(turn.join(" ")).toContain("The book asks:");
    expect(turn.some((line) => line.includes("What the reader believes by now"))).toBe(false);
    expect(turn.some((line) => line.includes("What this chapter does: complicate"))).toBe(true);
  });

  it("parses a stored arc tolerantly and refuses one that does not parse", () => {
    const plan = fourChapterPlan();
    const arc = bookArcSchema.parse({
      question: "Q?",
      answer: "A.",
      chapters: plan.chapters.map((chapter) => ({ index: chapter.index, kind: "CASE", pages: chapter.targetPages }))
    });
    expect(arc.chapters[0]!.kind).toBe("case");
    expect(planBookArc({ ...plan, bookArc: arc } as never)).toBeDefined();
    expect(planBookArc({ ...plan, bookArc: { question: "" } } as never)).toBeUndefined();
  });
});
''')
patch('packages/core/src/generation/seams.test.ts', [
('''  it("replaces only the first and last paragraphs", () => {
    const chapter = "One.\\n\\nTwo.\\n\\nThree.";
    expect(applySeam(chapter, { index: 1, opening: "Uno.", closing: "Tres." })).toBe("Uno.\\n\\nTwo.\\n\\nTres.");
    expect(chapterSeams(chapter)).toEqual({ opening: "One.", closing: "Three." });
  });''','''  it("replaces only the first and last paragraphs, whatever blank lines the chapter ends on", () => {
    const chapter = "One.\\n\\nTwo.\\n\\nThree.";
    expect(applySeam(chapter, { index: 1, opening: "Uno.", closing: "Tres." })).toBe("Uno.\\n\\nTwo.\\n\\nTres.");
    expect(applySeam(`${chapter}\\n\\n`, { index: 1, closing: "Tres." })).toBe("One.\\n\\nTwo.\\n\\nTres.");
    expect(chapterSeams(chapter)).toEqual({ opening: "One.", closing: "Three." });
  });'''),
])
# rendered-prompt test for a middle chapter under an arc
t=rd('packages/core/src/generation/composedChapter.test.ts')
if 'withholds the answer from a middle chapter' not in t:
    t=t.replace('''import { paginateChapterMarkdown } from "./chapterPagination.js";''','''import { bookArcSchema } from "./bookArc.js";
import { paginateChapterMarkdown } from "./chapterPagination.js";''',1)
    anchor='describe("composeChapter", () => {\n'
    assert anchor in t
    t=t.replace(anchor, anchor+'''  it("withholds the answer from a middle chapter under an arc: no thesis, premise, promises or positions reach its prompt", async () => {
    const base = makeFallbackPlan(input);
    const answer = "Offices give organised violence its reach and its targets.";
    const plan = {
      ...base,
      premise: `The premise says it outright: ${answer}`,
      promises: ["A promise that offices give organised violence its reach."],
      chapters: [1, 2, 3, 4].map((index) => ({ index, title: `Chapter ${index}`, summary: `Chapter ${index} proves that offices give violence its reach.`, keyBeats: [], targetPages: 6 }))
    };
    const arc = bookArcSchema.parse({
      question: "Whether organised violence follows temperament or offices?",
      answer,
      chapters: plan.chapters.map((chapter) => ({
        index: chapter.index,
        kind: chapter.index === 4 ? "resolution" : "case",
        pages: 6,
        job: { believesSoFar: "", does: `narrate: the episode of chapter ${chapter.index}.`, adds: "", leavesOpen: "" },
        cast: []
      }))
    });
    const stance = { thesis: answer, positions: ["A position naming offices and reach."], refusals: [], voiceSample: "A voice sample." };
    const fake = new FakeTextModelAdapter(input);
    const seen: GenerateTextOptions[] = [];
    const recording = {
      ...fake,
      generateText: (options: GenerateTextOptions) => {
        seen.push(options);
        return fake.generateText(options);
      }
    } as unknown as FakeTextModelAdapter;
    const chapter = plan.chapters[1]!;
    const palette = formPaletteFor("analytical-history");
    const fallback = fallbackChapterComposition({ chapter, startPage: 7, endPage: 12 }, palette, 1);
    // The fallback composition quotes the chapter summary into its subjects; the model's plan sees the arc's job instead.
    const composition = { ...fallback, sections: fallback.sections.map((section, offset) => ({ ...section, subject: `Subject ${offset + 1}`, owns: [] })) };
    await composeChapter({
      input,
      plan,
      stance,
      arc,
      chapter,
      composition,
      chapterPageStart: 7,
      chapterPageEnd: 12,
      earlierChapters: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: recording
    });
    const prompt = seen[0]!.messages.map((message) => message.content).join("\\n");
    expect(prompt).not.toContain(answer);
    expect(prompt).not.toContain(plan.premise);
    expect(prompt).not.toContain(plan.promises[0]!);
    expect(prompt).not.toContain(stance.positions[0]!);
    expect(prompt).not.toContain(chapter.summary);
    expect(prompt).toContain(arc.question);
    expect(prompt).toContain("narrate: the episode of chapter 2.");
    expect(prompt).toContain("Do not state the book's answer");
  });

''',1)
    wr('packages/core/src/generation/composedChapter.test.ts', t)
patch('apps/worker/src/generation/composedChaptersPass.test.ts', [('    // Described once after the compose and once more after the seams call rewrote the chapter\'s edges.\n    expect(purposes.filter((purpose) => purpose === "describe-pages")).toHaveLength(plan.chapters.length * 2);', '    // Described after the compose, again after the read\'s cut, and again after the seams call rewrote the chapter\'s edges.\n    expect(purposes.filter((purpose) => purpose === "describe-pages")).toHaveLength(plan.chapters.length * 3);')])
print("worker + tests patched")
