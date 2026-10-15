import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { MobileProjectChatMessageRecord } from "./dto.js";
import { findPendingScopeClarification, pendingEditProposalFromMetadata } from "./pendingEditState.js";

/**
 * The Apply path rebuilds the intent field by field from this whitelist rather
 * than deserializing the stored one, so anything not listed there is lost
 * between the card the reader approved and the charge that follows.
 */
describe("pendingEditProposalFromMetadata", () => {
  const confirmed = (intent: Record<string, unknown>) =>
    pendingEditProposalFromMetadata(
      { editProposal: { id: "proposal-1", kind: "page_rewrite", credits: 160 } },
      { clarification: "confirm", proposalId: "proposal-1", intent, affectedPageIndexes: [3, 7], credits: 160 },
      "Make page 3 funnier and page 7 shorter"
    );

  it("carries per-page instructions through to Apply", () => {
    const resumed = confirmed({
      kind: "page_rewrite",
      scope: "explicit_pages",
      affectedPageIndexes: [3, 7],
      perPageInstructions: [
        { pageIndex: 3, instruction: "Make it funnier." },
        { pageIndex: 7, instruction: "Make it shorter." }
      ]
    });

    expect(resumed.intent?.perPageInstructions).toEqual([
      { pageIndex: 3, instruction: "Make it funnier." },
      { pageIndex: 7, instruction: "Make it shorter." }
    ]);
  });

  it("drops instructions for pages the resumed edit no longer covers", () => {
    // The safe direction: a page with no entry gets the whole request, which is
    // what an edit without this field has always done, while an entry for a
    // page outside the set would be applied by nothing and paid for by nobody.
    const resumed = confirmed({
      kind: "page_rewrite",
      scope: "explicit_pages",
      affectedPageIndexes: [3, 7],
      perPageInstructions: [
        { pageIndex: 3, instruction: "Make it funnier." },
        { pageIndex: 99, instruction: "Gone." },
        { pageIndex: 7, instruction: "   " }
      ]
    });

    expect(resumed.intent?.perPageInstructions).toEqual([{ pageIndex: 3, instruction: "Make it funnier." }]);
  });

  it("leaves the field off entirely when the proposal carried none", () => {
    const resumed = confirmed({ kind: "page_rewrite", scope: "explicit_pages", affectedPageIndexes: [3, 7] });

    expect(resumed.intent).toBeDefined();
    expect(resumed.intent?.perPageInstructions).toBeUndefined();
  });

  it("keeps a stored instruction, and reports no instruction rather than the request", () => {
    // The two answers this rebuild must keep apart. `editInstruction` is new
    // and un-backfilled, so a card that stores none was written before the
    // field existed — and standing the raw request in for it turns "no
    // contract was recorded" into "a contract that differs from every
    // canonical clause", which the restructure Apply reads as a changed
    // contract and re-proposes instead of executing. Every consumer resolves
    // the absent case as `intent.editInstruction?.trim() || message.trim()`
    // over the same request, so nothing loses the fallback by asking for it.
    const stored = confirmed({
      kind: "page_rewrite",
      scope: "explicit_pages",
      affectedPageIndexes: [3, 7],
      editInstruction: "  Make page 3 funnier and page 7 shorter.  "
    });
    const legacy = confirmed({ kind: "page_rewrite", scope: "explicit_pages", affectedPageIndexes: [3, 7] });

    expect(stored.intent?.editInstruction).toBe("Make page 3 funnier and page 7 shorter.");
    expect(legacy.intent).toBeDefined();
    expect(legacy.intent).not.toHaveProperty("editInstruction");
  });

  it("preserves both proven router terms and the explicit mismatch sentinel", () => {
    const proven = confirmed({
      kind: "local_patch",
      scope: "all_pages",
      editInstruction: 'Replace "Rabbit" with "Fox" everywhere.',
      exactReplacement: { from: "Rabbit", to: "Fox" }
    });
    const mismatch = confirmed({
      kind: "local_patch",
      scope: "all_pages",
      editInstruction: 'Replace "Rabbit" with "Hare" everywhere.',
      exactReplacement: null
    });

    expect(proven.intent?.exactReplacement).toEqual({ from: "Rabbit", to: "Fox" });
    expect(mismatch.intent).toHaveProperty("exactReplacement", null);
  });
});

describe("findPendingScopeClarification", () => {
  let clock = 0;
  const turn = (role: "USER" | "ASSISTANT", content: string, metadata: Record<string, unknown> = {}): MobileProjectChatMessageRecord => ({
    id: `message-${(clock += 1)}`,
    projectId: "project-1",
    role,
    content,
    operationId: null,
    metadata,
    createdAt: new Date(Date.UTC(2026, 9, 6, 12, clock))
  });
  const asked = (clarification: string, request = "Add a dedication") =>
    turn("ASSISTANT", "What should the dedication say?", { pendingEdit: { request, clarification } });

  it("finds the matter composer's open question by its own kind", () => {
    const pending = findPendingScopeClarification(
      [turn("USER", "Add a dedication"), asked("matter")],
      "For my mom, who stood by me throughout"
    );

    expect(pending).toMatchObject({ request: "Add a dedication", clarification: "matter" });
  });

  it("forgets a question once a reply has followed its answer", () => {
    // The answering turn is marked by nothing, so without this every later
    // message was merged with the question's request.
    for (const clarification of ["matter", "scope"]) {
      const transcript = [
        turn("USER", "add an ISBN"),
        asked(clarification, "add an ISBN"),
        turn("USER", "978-0-306-40615-7"),
        turn("ASSISTANT", "Done — the ISBN line now reads “ISBN 978-0-306-40615-7”.")
      ];
      expect(findPendingScopeClarification(transcript, "make page 3 funnier"), clarification).toBeNull();
    }
  });

  it("still finds a priced proposal after an unrelated reply, asking for the explicit confirmation", () => {
    const pending = findPendingScopeClarification(
      [
        turn("USER", "Make page 3 funnier"),
        turn("ASSISTANT", "I’ll rewrite page 3.", {
          pendingEdit: { request: "Make page 3 funnier", clarification: "confirm", proposalId: "proposal-1" }
        }),
        turn("USER", "what is the book about?"),
        turn("ASSISTANT", "It’s about a lighthouse keeper.")
      ],
      "apply it"
    );

    expect(pending).toMatchObject({ clarification: "confirm", proposalId: "proposal-1", requiresExplicitConfirmation: true });
  });
});
