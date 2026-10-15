import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";
import { fakeDecideModel } from "../testing/bookEditIntentFixtures.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("a localized front-matter page request", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages(),
      contentRevision: 0,
      pdfPageMap: {
        version: 2,
        totalPdfPages: 4,
        hasCoverPage: true,
        pages: [{ index: 1, startPdfPage: 4, endPdfPage: 4 }],
        contentRevision: 0
      }
    }));
  });
  afterEach(teardownMobileHarness);

  it("keeps the Persian router language on composer failure without earlier conversation", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Change the author name on printed page one.",
      assistantMessage: "نام را تغییر می‌دهم.",
      responseLanguage: "fa",
      clarification: "none",
      pageIndexes: [1],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "pages"
    });
    const generateJson = vi.fn(async () => { throw new Error("composer unavailable"); });
    model.generateJson = generateJson;
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "نام نویسنده در صفحه ۱ را به علی تغییر بده" }
    });

    expect(response.statusCode).toBe(200);
    expect(generateJson).toHaveBeenCalled();
    expect(response.json().reply.metadata).toMatchObject({
      intent: { kind: "book_matter", responseLanguage: "fa" },
      replyLanguage: "fa"
    });
    expect(response.json().reply.content).toMatch(/^الان نتوانستم/);
    expect(response.json().operation).toBeNull();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(mockPrisma.bookEditOperation.create).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists a Persian Contents answer when routing succeeds but the grounded answer fails", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(projectRecord({
      id: "project-1", status: "COMPLETE", currentPlanId: "plan-1", currentPlan: approvedPlanRecord(),
      pages: generatedPages(), contentRevision: 0,
      pdfPageMap: {
        version: 2, totalPdfPages: 4, hasCoverPage: true, contentsStartPdfPage: 2,
        pages: [{ index: 1, startPdfPage: 3, endPdfPage: 4 }], contentRevision: 0
      }
    }));
    const model = fakeDecideModel({
      action: "propose_edit", confidence: 0.9, reasoning: "Fix printed page one.",
      assistantMessage: "صفحه را درست می‌کنم.", responseLanguage: "fa", clarification: "none",
      pageIndexes: [1], chapterIndex: null, targetLanguage: null, editTarget: "pages"
    });
    const generateText = vi.fn(async () => { throw new Error("grounded answer unavailable"); });
    model.generateText = generateText;
    const app = await buildMobileApp({ routingTextModel: model });
    const response = await app.inject({
      method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"),
      payload: { message: "صفحه ۱ را درست کن" }
    });

    expect(response.statusCode).toBe(200);
    expect(model.generateWithTools).toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled();
    const reply = response.json().reply;
    expect(reply.metadata.intent).toMatchObject({ kind: "answer", responseLanguage: "fa" });
    expect(reply.content).toContain("فهرست");
    expect(reply.content).not.toContain("Printed page");
    expect(mockPrisma.projectChatMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "ASSISTANT", content: reply.content })
    }));
    expect(response.json().operation).toBeNull();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(mockPrisma.bookEditOperation.create).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });
});
