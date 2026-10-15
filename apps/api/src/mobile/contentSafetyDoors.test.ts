import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  JEV_SELECTION,
  type DecisionModelAdapter,
  type DecisionRequest,
  type DecisionResult,
  type GenerationTextModelRouting
} from "@book-maker/core";
import { getImageQuota, hasActiveProjectEntitlement, reserveCredits, startGenerationAttempt } from "@book-maker/db/billing";
import type { FastifyInstance } from "fastify";
import { forgetSexualContentFilterSetting } from "../contentSafety.js";
import { forgetContentSafetyVerdicts } from "../contentSafetyScreen.js";
import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  creationDraftRecord,
  generatedPages,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { installShareStore, publishSharedBook, type ShareStore } from "./testing/shareTestSupport.js";

/**
 * The sexual-content filter's request and share screens at the doors
 * (`contentSafetyDoors.ts`, `../contentSafetyScreen.ts`): a confident verdict
 * refuses before anything is reserved, claimed or written, with the
 * deterministic screens' 422 body; an outage lets a request through and holds
 * a share for review; a filter the operator turned off asks nothing.
 */

const FALLBACK = { provider: "deepseek", model: "deepseek-chat" } as const;
const AUTH = bearer("token-a");

let decide: (request: DecisionRequest) => Promise<DecisionResult>;
let asked: DecisionRequest[];
let safetySettings: { findFirst: ReturnType<typeof vi.fn> };

function verdict(request: DecisionRequest, selectedOption: string, winner = 0.96): DecisionResult {
  const rest = (1 - winner) / (request.options.length - 1);
  const probabilities = Object.fromEntries(request.options.map((option) => [option.id, option.id === selectedOption ? winner : rest]));
  return { ...JEV_SELECTION, selectedOption, probabilities, usage: { promptTokens: 80, outputTokens: 0 } };
}

const refuseMinors = async (request: DecisionRequest) =>
  verdict(request, request.purpose === "moderation.book_share_caption" ? "allowed" : "child_safety");
const outage = async (): Promise<DecisionResult> => {
  throw new Error("gateway 503");
};

async function buildApp(): Promise<FastifyInstance> {
  return buildMobileApp({
    userTextModeration: {
      loadRouting: async () =>
        ({ fastDecisions: JEV_SELECTION, fastDecisionsFallback: FALLBACK, fastJudgments: FALLBACK }) as unknown as GenerationTextModelRouting,
      createAdapter: (): DecisionModelAdapter => ({
        choose: async (request) => {
          asked.push(request);
          return decide(request);
        }
      }),
      retry: { attempts: 1 }
    }
  });
}

function draftPlan(prompt: string) {
  const project = projectRecord({ id: "project-1", status: "PLAN_READY", currentPlanId: "plan-1", prompt });
  mockPrisma.planVersion.findFirst.mockResolvedValue({ id: "plan-1", projectId: "project-1", status: "DRAFT", inputSnapshot: null, project });
}

function expectNothingStarted() {
  expect(vi.mocked(getImageQuota)).not.toHaveBeenCalled();
  expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
  expect(vi.mocked(startGenerationAttempt)).not.toHaveBeenCalled();
  expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetMobileHarness();
  mockAccessTokens({ "token-a": "user-a" });
  forgetSexualContentFilterSetting();
  forgetContentSafetyVerdicts();
  asked = [];
  decide = refuseMinors;
  // No revision: the filter is on.
  safetySettings = { findFirst: vi.fn(async () => null) };
  (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision = safetySettings;
});

afterEach(async () => {
  delete (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision;
  await teardownMobileHarness();
});

describe("plan approval", () => {
  it("refuses a brief the screen confidently calls child-sexual, before the slot, the charge or the job", async () => {
    draftPlan("An erotic story about two 15-year-old classmates who fall in love.");
    const app = await buildApp();

    const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: AUTH });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "minor_sexual_content" });
    expect(response.json().error.message).toContain("under 18");
    expect(asked[0]!.context).toContain("15-year-old classmates");
    expectNothingStarted();
    await app.close();
  });

  it("lets the approval through when the moderator is down", async () => {
    draftPlan("A gentle story about a lighthouse cat and the storm that nearly takes the harbour.");
    decide = outage;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await buildApp();

    const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: AUTH });

    expect(response.json().error?.code).not.toBe("CONTENT_RESTRICTED");
    expect(vi.mocked(startGenerationAttempt)).toHaveBeenCalled();
    warn.mockRestore();
    await app.close();
  });

  it("asks nothing while the operator has the filter off", async () => {
    safetySettings.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false, copyrightRestrictionsEnabled: false });
    draftPlan("An erotic story about two 15-year-old classmates who fall in love.");
    const app = await buildApp();

    await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: AUTH });

    expect(asked).toEqual([]);
    expect(vi.mocked(startGenerationAttempt)).toHaveBeenCalled();
    await app.close();
  });
});

describe("the creation build", () => {
  it("refuses a book the reader's own chat asks to make sexual, before the advisor or the plan charge", async () => {
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "session-draft",
        payload: {
          payloadVersion: 3,
          rawIdea: "A school story",
          messages: [
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "A school story" },
            { role: "user", content: "Make the two eighth graders sleep together in chapter 2." }
          ],
          selectedPresets: { bookType: "workbook", lengthPreset: "short", qualityPreset: "balanced", imagesEnabled: true, pageCountMode: "custom", targetPages: 8, pageCountSource: "settings" }
        }
      })
    );
    const app = await buildMobileApp({
      advisorEnrichment: false,
      creationEnrichment: false,
      userTextModeration: {
        loadRouting: async () =>
          ({ fastDecisions: JEV_SELECTION, fastDecisionsFallback: FALLBACK, fastJudgments: FALLBACK }) as unknown as GenerationTextModelRouting,
        createAdapter: (): DecisionModelAdapter => ({ choose: async (request) => { asked.push(request); return decide(request); } }),
        retry: { attempts: 1 }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: AUTH,
      payload: { requestId: "build-request-refused" }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED" });
    expect(asked[0]!.context).toContain("eighth graders");
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("the finished-book chat", () => {
  function finishedBook() {
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1", currentPlan: approvedPlanRecord(), pages: generatedPages() })
    );
  }

  it("refuses an edit request before the message is written or held", async () => {
    finishedBook();
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: AUTH,
      payload: { message: "Make the two 14-year-olds on page 3 sleep together." }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "minor_sexual_content" });
    expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers the message as usual when the moderator is down", async () => {
    finishedBook();
    decide = outage;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: AUTH,
      payload: { message: "Continue the story and add 2 more chapters" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toBeTruthy();
    expect(asked.length).toBeGreaterThan(0);
    warn.mockRestore();
    await app.close();
  });
});

describe("a public share", () => {
  let store: ShareStore;
  let pages: Array<{ title: string; markdown: string }>;

  beforeEach(async () => {
    store = installShareStore();
    pages = [
      { title: "One", markdown: "The lighthouse keeper's cat watched the harbour." },
      { title: "Two", markdown: "Ships came and went." }
    ];
    const published = await publishSharedBook("project-1", 12, 2);
    const project = projectRecord({ status: "COMPLETE", pdfPageMap: published.pdfPageMap, title: "The Lighthouse Cat" });
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-1" && where.userId === "user-a" ? project : null
    );
    mockPrisma.project.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === "project-1" ? project : null));
    mockPrisma.page.findMany.mockImplementation(async () => pages);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
    vi.mocked(hasActiveProjectEntitlement).mockResolvedValue(false);
  });

  function share(app: FastifyInstance) {
    return app.inject({
      method: "PUT",
      url: "/api/mobile/projects/project-1/share",
      headers: AUTH,
      payload: { mode: "preview", previewPages: 2, rightsConfirmed: true }
    });
  }

  it("refuses a book whose text the screen confidently calls sexual, and writes nothing", async () => {
    pages[1] = { title: "Two", markdown: "An explicit scene." };
    decide = async (request) => verdict(request, request.context.includes("explicit scene") ? "sexual" : "allowed");
    const app = await buildApp();

    const response = await share(app);

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "sexual_content" });
    expect(asked.every((request) => request.purpose === "moderation.book_text")).toBe(true);
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("shares a book the screen could not decide and files it for an operator's review", async () => {
    decide = outage;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await buildApp();

    const response = await share(app);

    expect(response.statusCode).toBe(200);
    expect(store.shares).toHaveLength(1);
    expect(store.reports).toHaveLength(1);
    expect(store.reports[0]).toMatchObject({
      reporterUserId: null,
      targetType: "BOOK_SHARE",
      reason: "OTHER",
      targetSnapshot: { kind: "book_text_review", title: "The Lighthouse Cat", verdict: { surface: "book_text", verdict: "undecided" } }
    });
    warn.mockRestore();
    await app.close();
  });

  it("shares a clean book with no review", async () => {
    decide = async (request) => verdict(request, "allowed");
    const app = await buildApp();

    const response = await share(app);

    expect(response.statusCode).toBe(200);
    expect(store.reports).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);
    await app.close();
  });
});
