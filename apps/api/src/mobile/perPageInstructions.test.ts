import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  editablePages,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * One request, a different instruction per page.
 *
 * The value has to survive four hops — the router's answer, the proposal card,
 * the pendingEdit the Apply resumes from, and the job payload — and the third
 * one rebuilds the intent from a whitelist rather than deserializing it, so a
 * field that is not carried there is charged for and then silently ignored.
 */
function perPageRouterModel() {
  const decide = (args: Record<string, unknown>) => ({
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-decide", name: "decide", arguments: args }]
  });
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: async () => {
      throw new Error("generateJson is not used by the tool-calling router");
    },
    generateWithTools: async () =>
      decide({
        action: "propose_edit",
        confidence: 0.93,
        reasoning: "Two pages, two different changes.",
        assistantMessage: "I’ll rewrite those two pages.",
        editInstruction: "Make page 1 funnier and page 2 shorter.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "rewrite",
        pageIndexes: [1, 2],
        chapterIndex: null,
        targetLanguage: null,
        perPageInstructions: [
          { pageIndex: 1, instruction: "Make it funnier." },
          { pageIndex: 2, instruction: "Make it shorter." }
        ]
      }),
    async *streamText() {
      yield "";
    }
  };
}

describe("per-page instructions in one edit", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const completeProject = () =>
    projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });

  it("carries each page's own instruction into the queued job", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp({ routingTextModel: perPageRouterModel() });

    const proposed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make page 1 funnier and page 2 shorter." }
    });
    expect(proposed.statusCode).toBe(200);
    // Both pages are in scope, so both are counted and charged for.
    expect(proposed.json().reply.metadata.editProposal).toMatchObject({
      kind: "page_rewrite",
      affectedPageIndexes: [1, 2]
    });

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });

    expect(applied.statusCode).toBe(200);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          affectedPageIndexes: [1, 2],
          perPageInstructions: [
            { pageIndex: 1, instruction: "Make it funnier." },
            { pageIndex: 2, instruction: "Make it shorter." }
          ]
        })
      })
    );
    await app.close();
  });

  it("carries a mentioned character's sheet separately from every approved instruction", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      {
        id: "char-1",
        userId: "user-a",
        name: "Luna",
        description: "A brave night-flying rabbit.",
        fields: [{ key: "Age", value: "9" }],
        photoPath: null,
        photoKind: null,
        suggestedDescription: null,
        appearance: null,
        portraitPath: null,
        portraitSource: null,
        portraitStatus: "NONE",
        portraitError: null,
        portraitJobId: null,
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        updatedAt: new Date("2026-08-01T10:00:00.000Z")
      }
    ]);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp({ routingTextModel: perPageRouterModel() });

    const proposed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: {
        message: "Make page 1 funnier and page 2 shorter, and put @Luna in both.",
        mentionedCharacterIds: ["char-1"]
      }
    });
    expect(proposed.statusCode).toBe(200);

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: proposed.json().reply.metadata.editProposal.id }
    });
    expect(applied.statusCode).toBe(200);

    const payload = vi.mocked(enqueueGenerationJob).mock.calls.at(-1)![0].payload;
    const instructions = payload.perPageInstructions as { pageIndex: number; instruction: string }[];
    expect(payload.request).toBe("Make page 1 funnier and page 2 shorter, and put @Luna in both.");
    expect(payload.characterContext as string).toContain("night-flying");
    // The sheets are supplemental prompt context, not hidden additions to the
    // page-local or operation-level edit contracts.
    expect(instructions.map((entry) => entry.pageIndex)).toEqual([1, 2]);
    expect(instructions[0]!.instruction.startsWith("Make it funnier.")).toBe(true);
    expect(instructions[1]!.instruction.startsWith("Make it shorter.")).toBe(true);
    for (const entry of instructions) {
      expect(entry.instruction).not.toContain("Mentioned character profiles");
      expect(entry.instruction).not.toContain("night-flying");
    }
    await app.close();
  });
});
