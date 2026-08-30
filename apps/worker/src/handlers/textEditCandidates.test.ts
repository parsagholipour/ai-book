import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reviewAppliedBookEdit: vi.fn(),
  rewritePageForUserRequest: vi.fn()
}));

vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { ...actual, reviewAppliedBookEdit: mocks.reviewAppliedBookEdit };
});

vi.mock("../generation/textEditRewrite.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/textEditRewrite.js")>(
    "../generation/textEditRewrite.js"
  );
  return {
    locallyPatchedPage: actual.locallyPatchedPage,
    rewritePageForUserRequest: mocks.rewritePageForUserRequest
  };
});

import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";
import { draftTextEditCandidates, type TextEditSourcePage } from "./textEditCandidates.js";

const page = (index: number): TextEditSourcePage => ({
  id: `page-${index}`,
  index,
  title: `Page ${index}`,
  markdown: `Original ${index}`,
  summary: `Original summary ${index}`,
  imagePrompt: null,
  qualityReport: null,
  revision: 1,
  storyDelta: null,
  chapterId: null,
  chapter: null
});

const approvedDraft = (index: number, revision: number) => ({
  title: `Page ${index}`,
  markdown: `Candidate ${index}.${revision}`,
  summary: `Candidate summary ${index}.${revision}`,
  continuityNotes: [],
  qualityReport: { approved: true, score: 90 }
});

const baseOptions = () => ({
  projectId: "project-1",
  pages: [page(1), page(2)],
  input: {} as never,
  plan: { promises: [] } as never,
  strategy: {} as never,
  providers: { text: {} } as never,
  editInstruction: "Reveal the red key on page 2 and foreshadow it on page 1.",
  quality: { enabled: () => false }
});

describe("draftTextEditCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const revisions = new Map<number, number>();
    mocks.rewritePageForUserRequest.mockImplementation(async (options: { page: { index: number } }) => {
      const revision = (revisions.get(options.page.index) ?? 0) + 1;
      revisions.set(options.page.index, revision);
      return approvedDraft(options.page.index, revision);
    });
  });

  it("repairs only flagged pages and passes the verdict omissions into the next candidate", async () => {
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({
        satisfied: false,
        confidence: 0.95,
        missingRequirements: ["Page 2 does not reveal the red key."],
        contradictions: [],
        pageIndexesToRevise: [2]
      })
      .mockResolvedValueOnce({
        satisfied: true,
        confidence: 0.98,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

    const result = await draftTextEditCandidates(baseOptions());

    expect(result.satisfied).toBe(true);
    expect(result.audit).toMatchObject({ attempts: 2, proseApproved: true });
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(3);
    expect(mocks.rewritePageForUserRequest.mock.calls.map((call) => call[0].page.index)).toEqual([1, 2, 2]);
    expect(mocks.rewritePageForUserRequest.mock.calls[2]![0]).toMatchObject({
      adherenceRepair: ["Page 2 does not reveal the red key."]
    });
    expect(mocks.rewritePageForUserRequest.mock.calls[2]![0].priorPageOverrides).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, markdown: "Candidate 1.1" })])
    );
    expect(mocks.reviewAppliedBookEdit.mock.calls[0]![0].afterPages).toHaveLength(2);
  });

  it("keeps the durable instruction authoritative beside page guidance on initial and repair attempts", async () => {
    mocks.reviewAppliedBookEdit
      .mockResolvedValueOnce({
        satisfied: false,
        confidence: 0.95,
        missingRequirements: ["Page 1 does not foreshadow the key."],
        contradictions: [],
        pageIndexesToRevise: [1]
      })
      .mockResolvedValueOnce({
        satisfied: true,
        confidence: 0.98,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });
    const options = {
      ...baseOptions(),
      characterContext: "Mentioned character profiles:\n- Luna: a careful navigator",
      perPageInstructions: [{ pageIndex: 1, instruction: "Foreshadow the key in the closing sentence." }]
    };

    await draftTextEditCandidates(options);

    const durableInstruction = options.editInstruction;
    expect(mocks.rewritePageForUserRequest.mock.calls[0]![0]).toMatchObject({
      request: "Foreshadow the key in the closing sentence.",
      editInstruction: durableInstruction,
      pageEditGuidance: "Foreshadow the key in the closing sentence."
    });
    expect(mocks.rewritePageForUserRequest.mock.calls[1]![0]).toMatchObject({
      request: durableInstruction,
      editInstruction: durableInstruction
    });
    expect(mocks.rewritePageForUserRequest.mock.calls[1]![0]).not.toHaveProperty("pageEditGuidance");
    expect(mocks.rewritePageForUserRequest.mock.calls[2]![0]).toMatchObject({
      request: "Foreshadow the key in the closing sentence.",
      editInstruction: durableInstruction,
      pageEditGuidance: "Foreshadow the key in the closing sentence.",
      adherenceRepair: ["Page 1 does not foreshadow the key."]
    });
    for (const reviewCall of mocks.reviewAppliedBookEdit.mock.calls) {
      expect(reviewCall[0].instruction).toBe(durableInstruction);
      expect(reviewCall[0]).not.toHaveProperty("characterContext");
      expect(JSON.stringify(reviewCall[0])).not.toContain("careful navigator");
    }
    for (const rewriteCall of mocks.rewritePageForUserRequest.mock.calls) {
      expect(rewriteCall[0].characterContext).toBe(options.characterContext);
    }
  });

  it("stops after three operation-level candidates and returns an auditable failure", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: false,
      confidence: 0.9,
      missingRequirements: ["The key is still missing."],
      contradictions: [],
      pageIndexesToRevise: [1, 2]
    });

    const result = await draftTextEditCandidates(baseOptions());

    expect(result.satisfied).toBe(false);
    expect(result.audit).toMatchObject({
      attempts: 3,
      missingRequirements: ["The key is still missing."],
      proseApproved: true
    });
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(6);
  });

  it("re-asks an unverified review without redrafting and preserves its basis in the audit", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      basis: "unverified",
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."],
      contradictions: [],
      pageIndexesToRevise: [1, 2]
    });

    const result = await draftTextEditCandidates(baseOptions());

    expect(result.satisfied).toBe(false);
    expect(result.audit).toMatchObject({
      attempts: 3,
      verdict: { basis: "unverified", satisfied: false },
      proseApproved: true
    });
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledTimes(3);
    // Only the initial two drafts: the fail-closed page list and generic
    // message are evidence that no review ran, not a repair order.
    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledTimes(2);
  });

  it("repairs only prose-QA failures and includes their concrete revision notes", async () => {
    mocks.rewritePageForUserRequest.mockReset();
    mocks.rewritePageForUserRequest
      .mockResolvedValueOnce({
        ...approvedDraft(1, 1),
        qualityReport: {
          approved: false,
          score: 55,
          issues: ["The transition repeats the preceding page."],
          requiredRevisions: ["Replace the repeated transition with a new beat."]
        }
      })
      .mockResolvedValueOnce(approvedDraft(2, 1))
      .mockResolvedValueOnce(approvedDraft(1, 2));
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.98,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const result = await draftTextEditCandidates(baseOptions());

    expect(result.satisfied).toBe(true);
    expect(result.audit).toMatchObject({ attempts: 2, proseApproved: true });
    expect(mocks.rewritePageForUserRequest.mock.calls.map((call) => call[0].page.index)).toEqual([1, 2, 1]);
    expect(mocks.rewritePageForUserRequest.mock.calls[2]![0].adherenceRepair).toEqual([
      "Replace the repeated transition with a new beat.",
      "The transition repeats the preceding page."
    ]);
  });

  it("keeps a pure durable exact replacement on the mechanical path", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
    const result = await draftTextEditCandidates({
      ...baseOptions(),
      pages: [{ ...page(1), title: "Rabbit", markdown: "Rabbit ran.", summary: "Rabbit runs." }],
      editInstruction: 'Replace "Rabbit" with "Fox" throughout the whole book.',
      exactReplacement: { from: "Rabbit", to: "Fox" },
      mode: "exact"
    });

    expect(result.satisfied).toBe(true);
    expect(result.candidates[0]?.updated).toMatchObject({
      title: "Fox",
      markdown: "Fox ran.",
      summary: "Fox runs."
    });
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
    expect(mocks.reviewAppliedBookEdit).toHaveBeenCalledWith(
      expect.objectContaining({ exactReplacement: { from: "Rabbit", to: "Fox" } })
    );
  });

  it.each([
    {
      name: "ambiguous role-qualified rename",
      editInstruction: "Rename the hero Rabbit to Fox everywhere.",
      exactReplacement: { from: "hero Rabbit", to: "Fox" },
      operationExactReplacement: undefined
    },
    {
      name: "compound instruction",
      editInstruction: 'Replace "Rabbit" with "Fox" and make the tone darker.',
      exactReplacement: { from: "Rabbit", to: "Fox" },
      operationExactReplacement: undefined
    },
    {
      name: "durable instruction mismatch",
      editInstruction: 'Replace "Rabbit" with "Hare".',
      exactReplacement: { from: "Rabbit", to: "Fox" },
      operationExactReplacement: undefined
    },
    {
      name: "payload that disagrees with the stored router terms",
      editInstruction: 'Replace "Rabbit" with "Fox".',
      exactReplacement: { from: "Rabbit", to: "Fox" },
      operationExactReplacement: { from: "Rabbit", to: "Hare" }
    }
  ])(
    "refuses a $name instead of model-rewriting a patch-priced edit",
    async ({ editInstruction, exactReplacement, operationExactReplacement }) => {
      mocks.reviewAppliedBookEdit.mockResolvedValue({
        satisfied: true,
        confidence: 0.99,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      });

      await expect(
        draftTextEditCandidates({
          ...baseOptions(),
          pages: [{ ...page(1), markdown: "The hero Rabbit ran." }],
          editInstruction,
          exactReplacement,
          ...(operationExactReplacement ? { operationExactReplacement } : {}),
          mode: "exact"
        })
      ).rejects.toThrow(EDIT_ADHERENCE_FAILED);

      // `mode: "exact"` was quoted at zero credits on a preview, so neither a
      // provider call nor an adherence review may be bought for it here.
      expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
      expect(mocks.reviewAppliedBookEdit).not.toHaveBeenCalled();
    }
  );

  it("leaves a patch-priced page unchanged when its literal has gone, and rewrites nothing", async () => {
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 1,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const result = await draftTextEditCandidates({
      ...baseOptions(),
      pages: [
        { ...page(1), markdown: "Rabbit ran." },
        { ...page(2), title: "Elsewhere", markdown: "The fox already ran.", summary: "A fox runs." }
      ],
      editInstruction: 'Replace "Rabbit" with "Fox" throughout the whole book.',
      exactReplacement: { from: "Rabbit", to: "Fox" },
      mode: "exact"
    });

    expect(result.skippedPageIndexes).toEqual([2]);
    expect(result.candidates.map((candidate) => candidate.page.index)).toEqual([1]);
    expect(mocks.rewritePageForUserRequest).not.toHaveBeenCalled();
  });

  it("takes the model rewrite when a replacement rides a charged edit with no exact mode", async () => {
    // No `mode`, so the operation was priced as a page rewrite. The payload's
    // replacement is a hint about the reader's words, never authority to
    // substitute a free, self-approving splice for the prose they paid for.
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.99,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const result = await draftTextEditCandidates({
      ...baseOptions(),
      pages: [{ ...page(1), title: "Rabbit", markdown: "Rabbit ran.", summary: "Rabbit runs." }],
      editInstruction: 'Replace "Rabbit" with "Fox" throughout the whole book.',
      exactReplacement: { from: "Rabbit", to: "Fox" }
    });

    expect(mocks.rewritePageForUserRequest).toHaveBeenCalledOnce();
    expect(result.candidates[0]?.updated.markdown).toBe("Candidate 1.1");
    expect(result.skippedPageIndexes).toEqual([]);
    expect(mocks.reviewAppliedBookEdit.mock.calls[0]![0]).not.toHaveProperty("exactReplacement");
  });

  it("publishes a page whose best candidate still failed review instead of discarding the edit", async () => {
    // Page QA is not the adherence gate: a page that cannot be approved after
    // the whole-set repair budget is saved FAILED_QA by the publication, and
    // folding it in here refunded and threw away every other page of the edit.
    mocks.rewritePageForUserRequest.mockReset();
    const stubborn = {
      ...approvedDraft(2, 1),
      qualityReport: { approved: false, score: 51, issues: ["Still repeats page 1."], requiredRevisions: [] }
    };
    mocks.rewritePageForUserRequest.mockImplementation(async (options: { page: { index: number } }) =>
      options.page.index === 2 ? stubborn : approvedDraft(1, 1)
    );
    mocks.reviewAppliedBookEdit.mockResolvedValue({
      satisfied: true,
      confidence: 0.98,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });

    const result = await draftTextEditCandidates(baseOptions());

    expect(result.satisfied).toBe(true);
    expect(result.audit).toMatchObject({ attempts: 3, proseApproved: false });
    expect(result.candidates.map((candidate) => candidate.page.index)).toEqual([1, 2]);
    expect(result.candidates[1]?.updated.qualityReport.approved).toBe(false);
  });
});
