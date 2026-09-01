import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { critiquePageMap, mergePageMapCriticPatch } from "./pageMapCritic.js";
import type { BookPlan, ChapterBrief, CreateProjectInput } from "../schemas/book.js";

/**
 * The critic is the fifth writer of page 1's brief and the one that gets the
 * last word, so the first-page contract is asserted on both of its halves: the
 * prompt a `beatPatch` is written under, and the `missingEndingPressure`
 * substitution, which is our own sentence rather than a model's.
 */

const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";

/**
 * The book the critic is handed beside the map, which is where all three of the
 * first-page contract's questions are answered from: `targetPages` ranks page 1
 * against the book's last page, `plan.openingHook` is the commitment a patch has
 * to keep, and `mediaSettings.mobile.import` is the provenance that says whether
 * this book's opening is ours to commit at all.
 */
function book(options: {
  targetPages: number;
  hook?: string;
  imported?: boolean;
}): { input: CreateProjectInput; plan: BookPlan } {
  const input = {
    prompt: "Ada walks the river road, a character-led story about leaving.",
    category: "STORY",
    targetPages: options.targetPages,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral",
      ...(options.imported
        ? { mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } } }
        : {})
    }
  } as CreateProjectInput;
  const base = makeFallbackPlan(input);
  return { input, plan: options.hook ? { ...base, openingHook: options.hook } : base };
}

const briefs: ChapterBrief[] = [
  {
    chapterIndex: 1,
    title: "Opening",
    summary: "Ada leaves town.",
    continuityFocus: [],
    pages: [
      {
        pageIndex: 1,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs the lantern.",
        requiredContinuity: [],
        endingPressure: ""
      },
      {
        pageIndex: 2,
        chapterIndex: 1,
        purpose: "Establish Ada",
        beat: "Ada packs again.",
        requiredContinuity: [],
        endingPressure: "Ask why she delayed."
      }
    ]
  },
  {
    chapterIndex: 2,
    title: "The road",
    summary: "Ada walks the river road.",
    continuityFocus: [],
    pages: [
      {
        pageIndex: 4,
        chapterIndex: 2,
        purpose: "Cross the ford",
        beat: "Ada wades the ford.",
        requiredContinuity: [],
        endingPressure: "The water is rising."
      },
      {
        pageIndex: 5,
        chapterIndex: 2,
        purpose: "Reach the far bank",
        beat: "Ada reaches the far bank.",
        requiredContinuity: [],
        endingPressure: ""
      }
    ]
  }
];

/** The same map with one page carrying continuity written for the assignment it has. */
function briefsWithContinuity(pageIndex: number, lines: string[]): ChapterBrief[] {
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => (page.pageIndex === pageIndex ? { ...page, requiredContinuity: lines } : page))
  }));
}

/** The last page of the book `briefs` describes. Passed in, never inferred. */
const lastPageIndex = 5;

/** The same book cut down to the case where page 1 is also the last page. */
const onePageBriefs: ChapterBrief[] = [{ ...briefs[0]!, pages: [briefs[0]!.pages[0]!] }];

function capturingJsonModel(rawData: unknown): {
  model: TextModelAdapter;
  system?: string;
  payload?: Record<string, any>;
} {
  const capture: { model: TextModelAdapter; system?: string; payload?: Record<string, any> } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

const emptyPatch = {
  beatPatches: [],
  duplicatePurposeWarnings: [],
  missingEndingPressure: [],
  unscheduledPromises: []
};

describe("critiquePageMap first-page contract", () => {
  it("states the first-page rule and hands the critic the plan's openingHook", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({
      textModel: capture.model,
      briefs,
      promises: [],
      ...book({ targetPages: lastPageIndex, hook: openingHook })
    });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
  });

  it("keeps the first-page rule but sends no openingHook when the plan has none", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({ textModel: capture.model, briefs, promises: [], ...book({ targetPages: lastPageIndex }) });

    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("brief page 1 of a one-page book to close the book instead of hand off", async () => {
    const capture = capturingJsonModel(emptyPatch);

    await critiquePageMap({
      textModel: capture.model,
      briefs: onePageBriefs,
      promises: [],
      ...book({ targetPages: 1, hook: openingHook })
    });

    // Page 1 is still the reader's first impression and still owes the plan's
    // hook; only the handoff half of the contract flips, because the patch this
    // prompt licenses replaces the same field the substitution would have.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/openingHook is the plan's commitment/);
    expect(capture.payload?.openingHook).toBe(openingHook);
    expect(capture.system).not.toMatch(/second page has to answer/);
    expect(capture.system).toMatch(/also this book's last page/);
    expect(capture.system).toMatch(/Resolve the book's central promise/);
  });

  it("reads a map that stopped at page 1 as a truncated map, not as a one-page book", async () => {
    const capture = capturingJsonModel(emptyPatch);

    // Same briefs as the case above, and the opposite contract, because the only
    // thing that changed is the book. A map short of `targetPages` is the very
    // failure the brief repair loop exists for, so the highest index it holds is
    // not evidence of anything — and a page 1 briefed to close a twelve-page
    // book is the reader's first impression spending the ending on page one.
    await critiquePageMap({
      textModel: capture.model,
      briefs: onePageBriefs,
      promises: [],
      ...book({ targetPages: 12, hook: openingHook })
    });

    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
    expect(capture.system).not.toMatch(/also this book's last page/);
  });

  it("names no hook for an imported manuscript, whose plan invented one after the fact", async () => {
    const capture = capturingJsonModel(emptyPatch);

    // This pass gets the last word over page 1's brief, and it is the one
    // producer that used to be handed the hook as a bare string by the worker —
    // so it was the last door an import's invented hook could reach a model
    // through. An import's page 1 is the author's own first sentence; a patch
    // told to assign a hook that sentence was never written to is a rewrite of
    // it, and the writer prompts are gated too, so the hook's words would not
    // even be in the prompt that drafts the replacement.
    await critiquePageMap({
      textModel: capture.model,
      briefs,
      promises: [],
      ...book({ targetPages: lastPageIndex, hook: openingHook, imported: true })
    });

    expect(capture.system).not.toMatch(/openingHook/);
    expect(capture.system).not.toContain(openingHook);
    expect(capture.payload?.openingHook).toBeUndefined();
    // The ban half is not gated on the brief side: a patch is a production
    // assignment for prose about to be generated.
    expect(capture.system).toMatch(/Global page 1 is the book's first page/);
    expect(capture.system).toMatch(/endingPressure must leave a specific tension/);
  });
});

describe("mergePageMapCriticPatch", () => {
  it("patches duplicate purpose and fills missing endingPressure", () => {
    const merged = mergePageMapCriticPatch(briefs, {
      beatPatches: [
        {
          pageIndex: 2,
          purpose: "Ada decides to leave",
          beat: "Ada chooses the river road."
        }
      ],
      duplicatePurposeWarnings: ["Pages 1 and 2 shared a purpose."],
      missingEndingPressure: [1, 5],
      unscheduledPromises: ["The lantern will be lit."]
    }, lastPageIndex);

    // The substitution is deterministic code, so page 1 is the one page it must
    // not answer with the generic line the rest of the book gets.
    expect(merged[0]?.pages[0]?.endingPressure).toBe(
      "End the first page with a specific tension or open question the second page must answer."
    );
    // Page 5 is this book's last page, so the generic line would hand it a
    // consequence to carry into page 6.
    expect(merged[1]?.pages[1]?.endingPressure).toBe(
      "Resolve the book's central promise with a concrete final consequence."
    );
    expect(merged[1]?.pages[1]?.endingPressure).not.toMatch(/next page/);
    expect(merged[0]?.pages[1]?.purpose).toBe("Ada decides to leave");
    expect(merged[0]?.continuityFocus.some((line) => line.includes("lantern"))).toBe(true);
  });

  it("still carries a middle page's consequence into the next page", () => {
    const middle: ChapterBrief[] = [
      { ...briefs[0]!, pages: [briefs[0]!.pages[0]!, { ...briefs[0]!.pages[1]!, endingPressure: "" }] },
      briefs[1]!
    ];

    const merged = mergePageMapCriticPatch(middle, { ...emptyPatch, missingEndingPressure: [2] }, lastPageIndex);

    expect(merged[0]?.pages[1]?.endingPressure).toBe("Carry a concrete consequence into the next page.");
  });

  it("leaves a one-page book's only page out of the first-page pressure", () => {
    const onePage: ChapterBrief[] = [
      {
        ...briefs[0]!,
        pages: [briefs[0]!.pages[0]!]
      }
    ];

    const merged = mergePageMapCriticPatch(
      onePage,
      { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [1], unscheduledPromises: [] },
      1
    );

    expect(merged[0]?.pages[0]?.endingPressure).not.toMatch(/second page must answer/);
    // The collision resolves in favour of the ending rather than into the
    // generic line, which would hand the book's only page a next page.
    expect(merged[0]?.pages[0]?.endingPressure).toBe(
      "Resolve the book's central promise with a concrete final consequence."
    );
    expect(merged[0]?.pages[0]?.endingPressure).not.toMatch(/next page/);
  });

  it("keeps an ending pressure the map already had", () => {
    const merged = mergePageMapCriticPatch(briefs, { ...emptyPatch, missingEndingPressure: [2] }, lastPageIndex);

    expect(merged[0]?.pages[1]?.endingPressure).toBe("Ask why she delayed.");
  });

  it("appends a critic patch's continuity to what the page already carried", () => {
    const carrying = briefsWithContinuity(2, ["Ada still owes the ferryman."]);

    const merged = mergePageMapCriticPatch(
      carrying,
      { ...emptyPatch, beatPatches: [{ pageIndex: 2, requiredContinuity: ["Name the lantern."] }] },
      lastPageIndex
    );

    // A critic note is written about a page that keeps its assignment, so the
    // entries that assignment came with are still true of it.
    expect(merged[0]?.pages[1]?.requiredContinuity).toEqual(["Ada still owes the ferryman.", "Name the lantern."]);
  });

  it("replaces it for a patch that says it rewrote the whole assignment", () => {
    const carrying = briefsWithContinuity(2, ["Ada still owes the ferryman."]);

    const merged = mergePageMapCriticPatch(
      carrying,
      {
        ...emptyPatch,
        beatPatches: [
          {
            pageIndex: 2,
            purpose: "Ada counts the fare",
            beat: "Ada counts coins on the jetty.",
            endingPressure: "The ferry leaves without her.",
            requiredContinuity: ["Stay distinct from page 1, which already covers: Establish Ada Ada packs the lantern."],
            replaceRequiredContinuity: true
          }
        ]
      },
      lastPageIndex
    );

    // The ferryman line was written for the beat this patch replaced. Left
    // beside the new one it is the drafter told to go back to the assignment
    // the rewrite was paid to leave — `pageBeatDedup.ts` is the only caller
    // that sets the flag, and only for a page a model actually rewrote.
    expect(merged[0]?.pages[1]?.requiredContinuity).toEqual([
      "Stay distinct from page 1, which already covers: Establish Ada Ada packs the lantern."
    ]);
  });

  it("keeps the page's own continuity when a replacement names none", () => {
    const carrying = briefsWithContinuity(2, ["Ada still owes the ferryman."]);

    const merged = mergePageMapCriticPatch(
      carrying,
      { ...emptyPatch, beatPatches: [{ pageIndex: 2, replaceRequiredContinuity: true }] },
      lastPageIndex
    );

    // A patch carrying the flag and no lines forgot the field rather than
    // cleared it; a page with no continuity at all is not something any caller
    // asks for.
    expect(merged[0]?.pages[1]?.requiredContinuity).toEqual(["Ada still owes the ferryman."]);
  });

  it("redraws a page's visual moment for a patch that rewrote its whole assignment", () => {
    const illustrated = briefs.map((brief) => ({
      ...brief,
      pages: brief.pages.map((page) =>
        page.pageIndex === 2 ? { ...page, imageMoment: "Ada's lantern on the packed trunk." } : page
      )
    }));

    const merged = mergePageMapCriticPatch(
      illustrated,
      {
        ...emptyPatch,
        beatPatches: [
          {
            pageIndex: 2,
            purpose: "Ada counts the fare",
            beat: "Ada counts coins on the jetty.",
            endingPressure: "The ferry leaves without her.",
            imageMoment: "Coins counted twice on a wet jetty rail."
          }
        ]
      },
      lastPageIndex
    );

    // `...page` is spread first, so a field nothing after it names survives a
    // whole-assignment rewrite verbatim — and this one is what both the drafting
    // prompt and the interior-illustration prompt draw the page's picture from.
    expect(merged[0]?.pages[1]?.imageMoment).toBe("Coins counted twice on a wet jetty rail.");
  });

  it("leaves the page's own visual moment alone when a patch names none", () => {
    const illustrated = briefs.map((brief) => ({
      ...brief,
      pages: brief.pages.map((page) =>
        page.pageIndex === 2 ? { ...page, imageMoment: "Ada's lantern on the packed trunk." } : page
      )
    }));

    const merged = mergePageMapCriticPatch(
      illustrated,
      { ...emptyPatch, beatPatches: [{ pageIndex: 2, requiredContinuity: ["Name the lantern."] }] },
      lastPageIndex
    );

    // A critic note is not a reassignment, and the field is composer-only —
    // absent from `pageMapCriticPatchSchema` — so no critic patch can redraw a
    // page it merely annotated, and an unillustrated page stays unillustrated.
    expect(merged[0]?.pages[1]?.imageMoment).toBe("Ada's lantern on the packed trunk.");
    expect(merged[0]?.pages[0]?.imageMoment).toBeUndefined();
  });

  it("leaves a chapter's continuityFocus alone for a patch that adds no notes to it", () => {
    // `ChapterBrief.continuityFocus` has no cap of its own, so these are entries
    // the map's own producers wrote and the drafter has always been given.
    const crowded = briefs.map((brief) => ({
      ...brief,
      continuityFocus: Array.from({ length: 25 }, (_, index) => `Mapped constraint ${index + 1}.`)
    }));

    const merged = mergePageMapCriticPatch(
      crowded,
      { ...emptyPatch, beatPatches: [{ pageIndex: 2, purpose: "Ada decides to leave" }] },
      lastPageIndex
    );

    // The cap belongs to the notes this merge appends, not to the merge. Applied
    // unconditionally it fired on `beatDedupPatch`'s patches too — which carry no
    // notes at all — and `beatDedup` defaults to every effort tier while
    // `pageMapCritic` is ultra/premium, so one collision anywhere in a fast or
    // balanced book's map silently deleted the 21st constraint onward from every
    // chapter of it.
    expect(merged[0]?.continuityFocus).toHaveLength(25);
    expect(merged[0]?.continuityFocus.at(-1)).toBe("Mapped constraint 25.");
  });

  it("hands that list back as a copy rather than the brief's own array", () => {
    const mapped = briefs.map((brief) => ({ ...brief, continuityFocus: ["Keep the ferryman's name."] }));

    // `beatDedup` runs on every effort tier and composes a patch with both note
    // lists empty, so this is now the common path through the merge — and a
    // no-notes answer that returns the caller's array makes the merged brief's
    // `continuityFocus` the *input* brief's, on every chapter of every book. Any
    // later `push` — a brief repair's, a fallback path's — would then write
    // through to the map as it stood before the pass.
    const merged = mergePageMapCriticPatch(mapped, emptyPatch, lastPageIndex);

    expect(merged[0]?.continuityFocus).toEqual(["Keep the ferryman's name."]);
    expect(merged[0]?.continuityFocus).not.toBe(mapped[0]!.continuityFocus);
    merged[0]!.continuityFocus.push("Appended by a later pass.");
    expect(mapped[0]!.continuityFocus).toEqual(["Keep the ferryman's name."]);
  });

  it("still caps what its own notes grow that list to", () => {
    const nearlyFull = briefs.map((brief) => ({
      ...brief,
      continuityFocus: Array.from({ length: 19 }, (_, index) => `Mapped constraint ${index + 1}.`)
    }));

    const merged = mergePageMapCriticPatch(
      nearlyFull,
      {
        ...emptyPatch,
        unscheduledPromises: ["The lantern will be lit.", "The ferryman is paid."],
        duplicatePurposeWarnings: ["Pages 1 and 2 shared a purpose."]
      },
      lastPageIndex
    );

    // The whole brief is serialized into every page's drafting prompt, and these
    // notes are written for the *book*, so a critic with a long promise list
    // grows every chapter of it at once. That budget is still enforced by the
    // thing spending it: three notes onto nineteen entries is twenty-two, cut to
    // twenty.
    expect(merged[0]?.continuityFocus).toHaveLength(20);
    expect(merged[0]?.continuityFocus.at(-1)).toBe("Schedule payoff: The lantern will be lit.");
  });

  it("does not end the book on a page the map merely stopped at", () => {
    // The substitution is our own sentence, so this is the half where a short
    // map does its damage silently: page 5 is the highest index these briefs
    // hold and a middle page of the twelve-page book they belong to.
    const merged = mergePageMapCriticPatch(briefs, { ...emptyPatch, missingEndingPressure: [5] }, 12);

    expect(merged[1]?.pages[1]?.endingPressure).toBe("Carry a concrete consequence into the next page.");
    expect(merged[1]?.pages[1]?.endingPressure).not.toMatch(/Resolve the book's central promise/);
  });
});

describe("mergePageMapCriticPatch evidence ledger", () => {
  const ledgered: ChapterBrief[] = briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => ({
      ...page,
      claim: `Claim of page ${page.pageIndex}.`,
      evidenceAnchors: [`Anchor ${page.pageIndex}a`, `Anchor ${page.pageIndex}b`]
    }))
  }));

  it("keeps a page's claim and anchors under a note-only patch", () => {
    const merged = mergePageMapCriticPatch(
      ledgered,
      { ...emptyPatch, beatPatches: [{ pageIndex: 2, requiredContinuity: ["Stay distinct from page 1."] }] },
      lastPageIndex
    );

    expect(merged[0]?.pages[1]).toMatchObject({ claim: "Claim of page 2.", evidenceAnchors: ["Anchor 2a", "Anchor 2b"] });
  });

  it("drops the old claim and anchors under a whole-assignment rewrite that names none", () => {
    const merged = mergePageMapCriticPatch(
      ledgered,
      {
        ...emptyPatch,
        beatPatches: [
          {
            pageIndex: 2,
            purpose: "Trace the ration book",
            beat: "A Hamburg widow counts coupons.",
            endingPressure: "Leave the ration book half empty.",
            requiredContinuity: [],
            replaceRequiredContinuity: true
          }
        ]
      },
      lastPageIndex
    );

    expect(merged[0]?.pages[1]).not.toHaveProperty("claim");
    expect(merged[0]?.pages[1]).not.toHaveProperty("evidenceAnchors");
    expect(merged[0]?.pages[0]).toMatchObject({ claim: "Claim of page 1." });
  });

  it("applies a fresh claim and anchors a rewrite returns", () => {
    const merged = mergePageMapCriticPatch(
      ledgered,
      {
        ...emptyPatch,
        beatPatches: [
          {
            pageIndex: 2,
            purpose: "Trace the ration book",
            beat: "A Hamburg widow counts coupons.",
            endingPressure: "Leave the ration book half empty.",
            requiredContinuity: [],
            replaceRequiredContinuity: true,
            claim: "Rationing reached the kitchen before the front.",
            evidenceAnchors: ["Hamburg ration books", "turnip winter"]
          }
        ]
      },
      lastPageIndex
    );

    expect(merged[0]?.pages[1]).toMatchObject({
      claim: "Rationing reached the kitchen before the front.",
      evidenceAnchors: ["Hamburg ration books", "turnip winter"]
    });
  });
});

describe("critiquePageMap evidence ledger", () => {
  it("shows the critic each page's claim and anchors and tells it to patch a shared one, for an analytical book only", async () => {
    const analytical: CreateProjectInput = {
      ...book({ targetPages: 5 }).input,
      prompt: "The roots of conflict across the twentieth century.",
      category: "HISTORY"
    };
    const plan = makeFallbackPlan(analytical);
    const ledgered: ChapterBrief[] = briefs.map((brief) => ({
      ...brief,
      pages: brief.pages.map((page) => ({ ...page, claim: `Claim ${page.pageIndex}.`, evidenceAnchors: [`Case ${page.pageIndex}`] }))
    }));

    const capture = capturingJsonModel(emptyPatch);
    await critiquePageMap({ input: analytical, plan, textModel: capture.model, briefs: ledgered, promises: [] });
    expect(capture.system).toMatch(/fresh claim and evidenceAnchors/);
    expect(capture.payload?.pages?.[1]).toMatchObject({ claim: "Claim 2.", evidenceAnchors: ["Case 2"] });

    const story = book({ targetPages: 5 });
    const storyCapture = capturingJsonModel(emptyPatch);
    await critiquePageMap({ ...story, textModel: storyCapture.model, briefs: ledgered, promises: [] });
    expect(storyCapture.system).not.toMatch(/evidenceAnchors/);
  });
});
