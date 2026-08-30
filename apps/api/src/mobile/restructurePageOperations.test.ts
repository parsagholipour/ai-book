import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
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
 * What an Apply is allowed to execute, and what it has to ask about again.
 *
 * The instruction is resolved once more against the live manuscript at Apply,
 * so the reader can be shown a *changed* contract instead of being charged for
 * one they never saw. That comparison has an absent third answer: a card
 * written before `editInstruction` existed at all stores no instruction, and
 * treating its raw request as an approved canonical clause makes every one of
 * them differ from the re-resolution — a confirm button that silently answers
 * with a second, identical-looking card and self-heals on the next tap.
 */
describe("applying a confirmed page restructure", () => {
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

  /**
   * A stored proposal card, written straight into the transcript so the shape
   * of the *stored* intent is the thing under test rather than whatever this
   * build's proposal path happens to write today.
   */
  const storedProposal = (options: {
    request: string;
    intent: Record<string, unknown>;
    credits: number;
  }) => [
    {
      id: "chat-proposal-user",
      projectId: "project-1",
      role: "USER",
      content: options.request,
      operationId: null,
      metadata: {},
      createdAt: new Date("2026-06-15T11:00:00.000Z")
    },
    {
      id: "chat-proposal-assistant",
      projectId: "project-1",
      role: "ASSISTANT",
      content: "Tap Apply to run it.",
      operationId: null,
      metadata: {
        pendingEdit: {
          request: options.request,
          clarification: "confirm",
          proposalId: "11111111-1111-4111-8111-111111111111",
          credits: options.credits,
          intent: { kind: "restructure_pages", scope: "none", affectedPageIndexes: [], ...options.intent }
        },
        editProposal: {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "restructure_pages",
          credits: options.credits,
          summary: "A page change"
        }
      },
      createdAt: new Date("2026-06-15T11:01:00.000Z")
    }
  ];

  const apply = async (app: Awaited<ReturnType<typeof buildMobileApp>>) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: "11111111-1111-4111-8111-111111111111", requestId: "req-apply-1" }
    });

  it("runs a card that predates the stored instruction instead of proposing it again", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    // Every card outstanding at the deploy that introduced `editInstruction`
    // looks like this: the reader approved a delete, and the only text stored
    // beside it is what they typed.
    state.projectChatMessages.push(
      ...storedProposal({
        request: "delete the last page please",
        credits: 0,
        intent: { structuralEdit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 } }
      })
    );
    const app = await buildMobileApp();

    const applied = await apply(app);

    expect(applied.statusCode).toBe(200);
    // The tap executed the edit. It used to answer with a second card for the
    // same delete, which reads as a confirm button that did nothing.
    expect(applied.json().reply.metadata.editProposal).toBeUndefined();
    expect(applied.json().operation).toMatchObject({ kind: "restructure_pages", creditsCharged: 0 });
    const enqueued = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.at(0) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(enqueued.type).toBe("APPLY_BOOK_EDIT");
    expect(enqueued.payload.structuralEdit).toEqual({
      action: "delete",
      anchorPageIndex: null,
      pageIndexes: [2],
      pageCount: 0
    });
    // It executes the canonical clause the resolver just produced, not the
    // reader's own words — the durable instruction the worker will run.
    expect(state.bookEditOperations.at(-1)?.editInstruction).toBe(enqueued.payload.editInstruction);
    expect(enqueued.payload.editInstruction).not.toBe("delete the last page please");
    expect(String(enqueued.payload.editInstruction ?? "")).not.toHaveLength(0);
    await app.close();
  });

  it("re-proposes when the stored instruction no longer describes the live book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const project = completeProject();
    mockPrisma.project.findFirst.mockResolvedValue(project);
    // The other arm of the same predicate, kept beside the one above so the
    // absent case cannot be "simplified" back into a fallback that reads the
    // request as a contract: `restructurePageReproposal.test.ts` covers the
    // ways a live coordinate moves, this covers what "absent" is told apart
    // from. The card was priced when the book was twenty pages long; it is two
    // now, so the resolver clamps the anchor and the instruction the Apply
    // would execute is not the one on the card. The quote is unchanged, which
    // is the whole point: a moved coordinate is a changed contract even when
    // it costs the same.
    state.projectChatMessages.push(
      ...storedProposal({
        request: "Add a page after page 20.",
        credits: bookEditCreditCost("restructure_pages", 1, project as never),
        intent: {
          editInstruction: "Add 1 new page after page 20",
          structuralEdit: { action: "insert", anchorPageIndex: 20, pageIndexes: [], pageCount: 1 }
        }
      })
    );
    const app = await buildMobileApp();

    const applied = await apply(app);

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(applied.json().reply.metadata.editProposal).toMatchObject({ kind: "restructure_pages" });
    await app.close();
  });
});
