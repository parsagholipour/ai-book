import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import { TextModelAdapter } from "../adapters/types.js";
import { PageQualityReport } from "../schemas/book.js";
import { revisePageDraft, reviewPageDraft } from "./pagesReview.js";
import { GROUNDED_FACTUALITY_RULE } from "./pagesShared.js";
import { input, importedInput, plan, goodMarkdown, capturingReviewModel } from "./testing/pagesReviewFixtures.js";

describe("reviewPageDraft first-page rule", () => {
  const approvedReport = {
    approved: true,
    score: 92,
    issues: [],
    requiredRevisions: [],
    notes: "Approved.",
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };

  function capturingReviewModelWithSystem(rawData: unknown): {
    model: TextModelAdapter;
    payload?: Record<string, unknown>;
    systemPrompt?: string;
  } {
    const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; systemPrompt?: string } = {
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.systemPrompt = options.messages[0]?.content ?? "";
          capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
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

  it("tells the reviewer to reject throat-clearing first pages and hands it the plan's openingHook", async () => {
    const capture = capturingReviewModelWithSystem(approvedReport);
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.systemPrompt).toMatch(/first page, reject throat-clearing or meta openings/i);
    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("drops the first-page opening rule for an imported manuscript's page-1 repair", async () => {
    // The page reviewer has the same fork: a repair redrafts page 1 and this
    // reviewer judges the result, so an import that reached the repair pass at
    // all was judged against a rule its author was never given.
    const generated = capturingReviewModelWithSystem(approvedReport);
    await reviewPageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: generated.model
    });

    expect(generated.systemPrompt).toMatch(/first page, reject throat-clearing or meta openings/i);

    const imported = capturingReviewModelWithSystem(approvedReport);
    await reviewPageDraft({
      input: importedInput,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: imported.model
    });

    expect(imported.systemPrompt).toBeDefined();
    expect(imported.systemPrompt).not.toMatch(/first page, reject throat-clearing or meta openings/i);
  });

  it("names the openingHook it hands the reviewer, as delivery rather than echo", async () => {
    // The payload key shipped with no rule naming it, next to pageBrief - and
    // the natural reading of an unlabelled field ("the page must match it")
    // contradicts what `buildPageInstruction` tells the writer, which is to
    // deliver the hook "without echoing its wording". A correctly transformed
    // page 1 could be rejected for not reproducing it.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const capture = capturingReviewModelWithSystem(approvedReport);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);
    expect(capture.systemPrompt).toMatch(/openingHook is the plan's commitment to how this book opens/i);
    expect(capture.systemPrompt).toMatch(/never require it to reproduce, quote, or echo the hook's wording/i);

    await reviewPageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 7,
      draft: {
        title: "The Door Opens",
        markdown: goodMarkdown(),
        summary: "Jack crosses the threshold and commits to a dangerous choice.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: capture.model
    });

    // The rule and the key leave together, so no page is shown one without the
    // other.
    expect(capture.payload?.openingHook).toBeUndefined();
    expect(capture.systemPrompt).not.toMatch(/openingHook/);
  });

  it("names no openingHook to the reviewer or the reviser on an imported manuscript's page 1", async () => {
    // The hook rides the import exemption for the reason this pair makes
    // visible. A fresh import's plan has no `openingHook` at all
    // (`synthesizeImportedBookPlan`); one appears only when a later replan
    // invents it from the premise, having never read page 1. Told to judge
    // whether page 1 delivers it, this reviewer rejects the author's own opening
    // - and the only repair for that verdict is `revisePageDraft`, which was
    // being handed the same invented hook as an instruction to rewrite the
    // author's sentence into it.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const review = capturingReviewModelWithSystem(approvedReport);

    await reviewPageDraft({
      input: importedInput,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: review.model
    });

    expect(review.systemPrompt).toBeDefined();
    expect(review.systemPrompt).not.toMatch(/openingHook/);
    expect(review.payload?.openingHook).toBeUndefined();
    expect(JSON.stringify(review.payload)).not.toContain(hookPlan.openingHook);

    const revise = capturingReviewModelWithSystem({
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack is caught mid-climb when the chapel bell starts.",
      continuityNotes: []
    });

    await revisePageDraft({
      input: importedInput,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      // The failure that reaches page 1 of an import is never about its opening:
      // the opening rule is silenced for it in both reviewers, so what lands
      // here is repetition, a prompt leak, or a reader's own edit request.
      report: {
        ...approvedReport,
        approved: false,
        score: 40,
        issues: ["Repeats a phrase from page 3."],
        requiredRevisions: ["Replace the repeated phrasing."],
        groundedOk: true,
        unsupportedClaims: []
      },
      previousPages: [],
      continuityNotes: [],
      textModel: revise.model
    });

    expect(revise.payload?.openingHook).toBeUndefined();
    expect(String(revise.payload?.instruction)).not.toMatch(/openingHook/);
    expect(JSON.stringify(revise.payload)).not.toContain(hookPlan.openingHook);
  });
});

describe("revisePageDraft first-page hook", () => {
  const rejection: PageQualityReport = {
    approved: false,
    score: 45,
    issues: ["First page opens with a generic or meta hook instead of a concrete one."],
    requiredRevisions: ["Open inside the scene the plan commits to."],
    notes: "Local quality checks rejected the page.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: false
    }
  };

  function reviseOptions(pageIndex: number, hookPlan: typeof plan, textModel: TextModelAdapter) {
    return {
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex,
      draft: {
        title: "The Wall Bell",
        markdown: goodMarkdown(),
        summary: "Jack is caught mid-climb when the chapel bell starts.",
        continuityNotes: []
      },
      report: rejection,
      previousPages: [],
      continuityNotes: [],
      textModel
    };
  }

  it("hands the reviser the openingHook its own instruction names, on page 1 only", async () => {
    // `buildPageInstruction` tells the writer to deliver "the plan's
    // openingHook". The revision payload carried no such key, so the rewrite
    // of the page most likely to need the hook was pointed at nothing.
    const hookPlan = { ...plan, openingHook: "Jack is mid-climb over the chapel wall when the bell starts." };
    const capture = capturingReviewModel({
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack is caught mid-climb when the chapel bell starts.",
      continuityNotes: []
    });

    await revisePageDraft(reviseOptions(1, hookPlan, capture.model));

    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);
    expect(capture.payload?.instruction).toMatch(/openingHook/);
    expect(capture.system).toContain(GROUNDED_FACTUALITY_RULE);
    expect(capture.payload?.instruction).toContain(GROUNDED_FACTUALITY_RULE);

    await revisePageDraft(reviseOptions(7, hookPlan, capture.model));

    expect(capture.payload?.openingHook).toBeUndefined();
  });
});
