import { dryRunDetail } from "./fakeDryRunBeats.js";
import type { GenerateJsonOptions, GenerateTextOptions } from "./types.js";

/**
 * The fake adapter's answers for the composed-chapters strategy
 * (`generation/composedChapter.ts`, `generation/chapterForms.ts`): a chapter
 * of dry-run prose sized to the word budget the real writer is held to, a
 * form plan drawn from the palette the prompt sent, and page descriptions with
 * image prompts only where the payload asked for them. Split from `fake.ts`
 * for the file-size budget, like the dry-run beats and the edit-adherence fake.
 */
/** The composed-chapters user payload names its page count in chapterPosition; fall back to the word budget. */
function fakeComposedChapterPages(options: GenerateTextOptions): number {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  try {
    const payload = JSON.parse(user) as { chapterPosition?: { pages?: unknown }; wordBudget?: { perPage?: unknown; target?: unknown } };
    const pages = payload.chapterPosition?.pages;
    if (typeof pages === "number" && pages > 0) {
      return pages;
    }
    const perPage = payload.wordBudget?.perPage;
    const target = payload.wordBudget?.target;
    if (typeof perPage === "number" && typeof target === "number" && perPage > 0) {
      return Math.max(1, Math.round(target / perPage));
    }
  } catch {
    // Not the composed-chapters payload; one page of prose is enough.
  }
  return 1;
}

/** The canned figure of the kind the form plan assigned, so the whole figure path runs under `MOCK_AI`. */
function fakeFigureFence(kind: string): string {
  const spec =
    kind === "flow"
      ? {
          kind: "flow",
          title: "How a cart is admitted at the north gate",
          nodes: [
            { id: "a", label: "Cart arrives", shape: "start" },
            { id: "b", label: "Ledger checked" },
            { id: "c", label: "Toll paid?", shape: "decision" },
            { id: "d", label: "Sent to the tollhouse" },
            { id: "e", label: "Admitted", shape: "end" }
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
            { from: "c", to: "d", label: "No" },
            { from: "d", to: "b" },
            { from: "c", to: "e", label: "Yes" }
          ],
          source: "The gate procedure this chapter describes",
          caption: "A cart waits until its toll is on the ledger."
        }
      : {
          kind,
          title: "Carts through the north gate by decade",
          categories: ["1500", "1510", "1520"],
          series: [{ name: "Carts", values: [120, 140, 95] }],
          source: "The dry-run ledger",
          caption: "Counted at the gate each spring."
        };
  return "```figure\n" + JSON.stringify(spec) + "\n```";
}

export function fakeComposedChapter(options: GenerateTextOptions): string {
  const pages = fakeComposedChapterPages(options);
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let chapterIndex = 1;
  let targetWords = pages * 430;
  let figureKind: string | undefined;
  try {
    const payload = JSON.parse(user) as {
      chapter?: { index?: unknown };
      chapterPosition?: { index?: unknown };
      wordBudget?: { target?: unknown };
      composition?: { sections?: Array<{ figure?: { kind?: unknown } }> };
    };
    const index = payload.chapter?.index ?? payload.chapterPosition?.index;
    if (typeof index === "number") chapterIndex = index;
    if (typeof payload.wordBudget?.target === "number") targetWords = payload.wordBudget.target;
    const planned = payload.composition?.sections?.find((section) => section.figure)?.figure?.kind;
    if (typeof planned === "string") figureKind = planned;
  } catch {
    // ignore
  }
  // Enough prose to meet the budget the real writer is held to, in paragraphs
  // of visibly different lengths so the paginator has boundaries to cut on.
  const paragraphs: string[] = [];
  let words = 0;
  for (let turn = 0; words < targetWords * 0.8 || turn < pages; turn += 1) {
    const detail = dryRunDetail(chapterIndex * 100 + turn + 1);
    // Openers vary by turn: prose whose sentences all begin the same way is
    // what the degeneracy guard refuses, and the fake has to pass it.
    // Every sentence opens on its own turn number, so no three-word opening
    // repeats and the fake passes the guard the way prose does.
    const n = turn + 1;
    const long = `Turn ${n} of chapter ${chapterIndex} brings the dry run to ${detail}. Scene ${n} stays in one place long enough to be seen: a table, a ledger, a road out of town, and the person who has to decide what to do about it before the light goes. Year ${n} goes unnamed, because the year is on the ledger, and the ledger is what the person is looking at while the road empties.`;
    const middle = `Nobody at stop ${n} explains ${detail}; it is simply there, and the page moves through it the way a reader would, noticing the one object that matters and leaving the rest where it lies.`;
    const short = `Beat ${n} lands. Stop ${n} ends on ${detail}.`;
    paragraphs.push(long, middle, short);
    // The planned figure sits after the first paragraph that introduces it.
    if (turn === 0 && figureKind) paragraphs.splice(1, 0, fakeFigureFence(figureKind));
    words += long.split(/\s+/).length + middle.split(/\s+/).length + short.split(/\s+/).length;
    if (turn > pages * 40) break;
  }
  return paragraphs.join("\n\n");
}

export function fakeChapterForms(options: GenerateJsonOptions<unknown>): unknown[] {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let chapters: Array<{ chapterIndex: number; title?: string; summary?: string; sectionCount?: { min: number; max: number } }> = [];
  let palette: Array<{ form: string }> = [];
  let figures = false;
  try {
    const payload = JSON.parse(user) as {
      chapters?: typeof chapters;
      palette?: typeof palette;
      outputContract?: { chapters?: Array<{ sections?: Array<{ figure?: unknown }> }> };
    };
    chapters = payload.chapters ?? [];
    palette = payload.palette ?? [];
    // The key is shown only to an eligible book's planner; the fake answers it
    // with one chart and one flow diagram so both renderers run.
    figures = payload.outputContract?.chapters?.[0]?.sections?.[0]?.figure !== undefined;
  } catch {
    // ignore
  }
  const forms = palette.map((entry) => entry.form).filter((form) => form !== "quiet-transition");
  return chapters.map((chapter, offset) => {
    // Counts and shares vary the way the form planner is asked to make them.
    const min = chapter.sectionCount?.min ?? 3;
    const max = Math.max(min, chapter.sectionCount?.max ?? 4);
    const count = Math.max(3, min + (offset % Math.max(1, max - min + 1)));
    return {
      chapterIndex: chapter.chapterIndex,
      throughLine: chapter.summary ?? `Chapter ${chapter.chapterIndex}`,
      sections: Array.from({ length: count }, (_, index) => ({
        form: forms.length > 0 ? forms[(offset * 2 + index * 3) % forms.length] : "scene",
        subject: `${chapter.title ?? "The chapter"}: ${dryRunDetail(chapter.chapterIndex * 10 + index)}`,
        share: index === 0 ? 0.45 : index === count - 1 ? 0.1 : 0.45 / Math.max(1, count - 2),
        owns: [dryRunDetail(chapter.chapterIndex * 10 + index)],
        ...(figures && index === 0 && offset === 0
          ? { figure: { kind: "bar", shows: "carts through the north gate by decade", source: "the dry-run ledger" } }
          : figures && index === 0 && offset === 1
            ? { figure: { kind: "flow", shows: "how a cart is admitted at the gate", source: "the gate procedure this chapter describes" } }
            : {})
      })),
      landing: `${chapter.title ?? `Chapter ${chapter.chapterIndex}`} ends at ${
        ["Vindolanda", "Corbridge", "Housesteads", "Chesters", "Birdoswald", "Carlisle", "Wallsend", "Eboracum"][offset % 8]
      } in ${1500 + chapter.chapterIndex}.`,
      avoid: []
    };
  });
}

export function fakeDescribedPages(options: GenerateJsonOptions<unknown>): unknown[] {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let pages: Array<{ index: number; markdown?: string }> = [];
  let illustrated: number[] = [];
  try {
    const payload = JSON.parse(user) as { pages?: typeof pages; illustratedPageIndexes?: number[] };
    pages = payload.pages ?? [];
    illustrated = payload.illustratedPageIndexes ?? [];
  } catch {
    // ignore
  }
  return pages.map((page) => {
    const detail = dryRunDetail(page.index);
    return {
      index: page.index,
      title: `Dry Run Turn ${page.index}`,
      summary: `Page ${page.index} advances the dry-run book through ${detail}.`,
      continuityNotes: [`Page ${page.index} establishes ${detail} as a distinct dry-run detail.`],
      ...(illustrated.includes(page.index)
        ? { imagePrompt: `Reader-facing illustration for page ${page.index}: a scene centered on ${detail}.` }
        : {})
    };
  });
}

/** The focused pass returns the chapter it was handed: the fake removes no moves, and the caller must accept an unchanged chapter. */
export function fakeDetemplatedChapter(options: GenerateTextOptions): string {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  try {
    const payload = JSON.parse(user) as { chapter?: unknown };
    if (typeof payload.chapter === "string") return payload.chapter;
  } catch {
    // ignore
  }
  return fakeComposedChapter(options);
}

/** The canned cut: the draft with its last paragraph removed, so the deletion check passes and the path is exercised. */
export function fakeCutChapter(options: GenerateTextOptions): string {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let draft = "";
  try {
    const parsed = JSON.parse(user) as { draft?: unknown };
    draft = typeof parsed.draft === "string" ? parsed.draft : "";
  } catch {
    draft = "";
  }
  const paragraphs = draft.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0);
  return paragraphs.length > 1 ? paragraphs.slice(0, -1).join("\n\n") : draft;
}

/** The canned arc: the plan's chapters, kinds cycled, pages as the plan had them, one job each. */
export function fakeBookArc(options: GenerateJsonOptions<unknown>): unknown {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let chapters: Array<{ index: number; title?: string; targetPages?: number }> = [];
  try {
    chapters = (JSON.parse(user) as { chapters?: typeof chapters }).chapters ?? [];
  } catch {
    chapters = [];
  }
  const kinds = ["method", "case", "document", "complication", "portrait", "argument", "case"];
  return {
    question: "Whether organised violence follows temperament or offices.",
    opponent: { name: "A named opponent", work: "A published work", year: 2011, claim: "Its claim.", whereRight: "Where it is right.", whereTheBookBreaks: "Where the book breaks with it." },
    answer: "Offices give violence its reach.",
    turn: { chapterIndex: Math.max(1, Math.min(chapters.length, Math.ceil(chapters.length * 0.6))), trouble: "A crowd kills without an office.", repair: "The committee is the office." },
    chapters: chapters.map((chapter, offset) => ({
      index: chapter.index,
      kind: offset === chapters.length - 1 ? "resolution" : kinds[offset % kinds.length],
      pages: chapter.targetPages ?? 1,
      job: {
        believesSoFar: `What the reader believes after chapter ${chapter.index - 1}.`,
        does: `establish: what chapter ${chapter.index} does.`,
        adds: `What chapter ${chapter.index} adds.`,
        leavesOpen: `What chapter ${chapter.index} leaves open.`
      },
      cast: [`Person ${chapter.index}`],
      dispute: { sideA: { name: "Side A", claim: "claim A" }, sideB: { name: "Side B", claim: "claim B" }, atStake: "the stake" }
    })),
    proposal: "The proposal, in prose."
  };
}

/** The canned seams: every paragraph returned unchanged, so the acceptance sees no replacement. */
export function fakeSeams(options: GenerateJsonOptions<unknown>): unknown {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  try {
    const chapters = (JSON.parse(user) as { chapters?: Array<{ index: number; opening: string; closing: string }> }).chapters ?? [];
    // A visibly different seam per chapter that keeps every name and number, so
    // the deterministic acceptance takes it and no two closings look alike.
    const objects = ["a ledger", "a letter", "a map", "a count", "a name", "a door", "a road"];
    return {
      chapters: chapters.map((chapter) => ({
        index: chapter.index,
        opening: `${chapter.opening} Begin with ${objects[chapter.index % objects.length]}.`,
        closing: `${chapter.closing} What stays open here is ${objects[(chapter.index + 3) % objects.length]}.`
      }))
    };
  } catch {
    return { chapters: [] };
  }
}
