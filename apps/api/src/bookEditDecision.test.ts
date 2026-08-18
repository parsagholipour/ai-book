import { MAX_INSERTED_PAGES, resolveStructuralPageEdit, type ExistingPage } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { type BookEditIntent } from "./bookEditIntent.js";
import { intentFromProposeEdit } from "./bookEditDecision.js";
import { MODEL_PAGE_NUMBERING } from "./bookPageNumbering.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";
import { structuralRefusalMessage } from "./mobile/structuralPageEdits.js";

/**
 * One cap, one answer.
 *
 * `MAX_INSERTED_PAGES` is enforced in exactly one place — `resolveStructuralPageEdit`,
 * which the proposal and the Apply both run — and it used to be enforced a
 * second time here, where the router's count was clamped to it before the intent
 * was built. Two enforcements are two answers to one message: clamped,
 * "add 12 pages after page 10" resolved as an accepted ten-page insert that was
 * priced, carded and charged with nothing anywhere saying two pages were
 * dropped, while the identical message on the router-outage path kept its
 * twelve, reached `too_many_pages` and was answered for free with the sentence
 * naming the real limit. `structuralPageCount`'s schema bound was the same clamp
 * one layer up — it reaches the model as `maximum`, so a router asked for twelve
 * answered ten — and is now well above the cap for the same reason: a number the
 * router cannot say is a refusal the reader can never reach.
 *
 * Both paths converge on `proposeBookEdit`, whose structural fork resolves
 * before it prices, so a refusal here reserves nothing and charges nothing on
 * either of them. That is what `answerFor` below stands in for.
 */
describe("an insert past the cap, through the router and without it", () => {
  const OVER_CAP = MAX_INSERTED_PAGES + 2;
  const MESSAGE = `Add ${OVER_CAP} pages after page 10.`;
  const REFUSAL = `I can add up to ${MAX_INSERTED_PAGES} pages at a time. Ask again for more once these are in.`;

  const bookPages = Array.from({ length: 12 }, (_value, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    title: `The ${offset + 1} Winds`,
    summary: "",
    previewText: ""
  }));
  const existingPages: ExistingPage[] = bookPages.map((page) => ({
    id: page.id,
    index: page.index,
    chapterId: null
  }));

  const proposeEdit = (decision: Partial<DecideActionPayload>) =>
    ({
      action: "propose_edit" as const,
      confidence: 0.9,
      reasoning: "Structural page edit.",
      assistantMessage: "I’ll do that.",
      clarification: "none" as const,
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      ...decision
    }) as DecideActionPayload;

  /**
   * What the reader ends up with: the pages a plan would bill, or the free
   * sentence a refusal is settled with. Resolved through the real resolver and
   * the real copy, in the order `proposeBookEdit` calls them.
   */
  const answerFor = (intent: BookEditIntent): { charged: number; reply: string | null } => {
    const resolved = resolveStructuralPageEdit(intent.structuralEdit!, existingPages);
    return resolved.ok
      ? { charged: resolved.plan.pagesBilled, reply: null }
      : { charged: 0, reply: structuralRefusalMessage(resolved.reason, intent, MODEL_PAGE_NUMBERING) };
  };

  it("refuses for free on the model-free path, where nothing ever clamped", () => {
    const intent = classifyWithDegradedHeuristics(MESSAGE, "complete", bookPages);

    expect(intent.kind).toBe("restructure_pages");
    expect(intent.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 10,
      pageIndexes: [],
      pageCount: OVER_CAP
    });
    expect(answerFor(intent)).toEqual({ charged: 0, reply: REFUSAL });
  });

  it("gives the router's own count that same refusal instead of quietly writing ten", () => {
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 10, structuralPageCount: OVER_CAP }),
      MESSAGE,
      []
    );

    // The clamp lived on this line: it read `MAX_INSERTED_PAGES` here, which
    // resolves to a plan billing ten pages rather than to the sentence above.
    expect(intent.structuralEdit?.pageCount).toBe(OVER_CAP);
    expect(answerFor(intent)).toEqual({ charged: 0, reply: REFUSAL });
  });

  it("gives a count borrowed from the message that same refusal too", () => {
    // The router named the edit and left the count to the message, so
    // `structuralIntentFromDecision` reads the recogniser's. That is the half of
    // the clamp a router which never emits an out-of-range number still reached.
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 10 }),
      MESSAGE,
      []
    );

    expect(intent.structuralEdit?.pageCount).toBe(OVER_CAP);
    expect(answerFor(intent)).toEqual({ charged: 0, reply: REFUSAL });
  });

  it("still writes the pages at exactly the cap, on both paths", () => {
    // The boundary the refusal is measured from: two pages fewer than the
    // request above is a real edit, and both paths price it as the same one.
    const atCap = `Add ${MAX_INSERTED_PAGES} pages after page 10.`;
    const routed = intentFromProposeEdit(
      proposeEdit({
        editTarget: "insert_pages",
        structuralAnchorPageIndex: 10,
        structuralPageCount: MAX_INSERTED_PAGES
      }),
      atCap,
      []
    );
    const degraded = classifyWithDegradedHeuristics(atCap, "complete", bookPages);

    expect(routed.structuralEdit).toEqual(degraded.structuralEdit);
    expect(answerFor(routed)).toEqual({ charged: MAX_INSERTED_PAGES, reply: null });
    expect(answerFor(degraded)).toEqual({ charged: MAX_INSERTED_PAGES, reply: null });
  });

  it("still reads a router that named no count at all as one page", () => {
    // The floor is not the cap, and removing the cap must not take it with it:
    // "add a page" names no number, and neither does a decision that leaves the
    // field out with nothing in the message for the recogniser to borrow.
    const intent = intentFromProposeEdit(
      proposeEdit({ editTarget: "insert_pages", structuralAnchorPageIndex: 4 }),
      "I'd like a new page in there.",
      []
    );

    expect(intent.structuralEdit?.pageCount).toBe(1);
  });
});
