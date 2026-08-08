import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { refundCreditLedgerEntry, reserveCredits } from "@book-maker/db/billing";

import { cancelUndispatchedGenerationJob, dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  creationPayload,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile creation build and outputs", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("finalizes a creation draft into a project and queues first plan generation", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = creationPayload({
      brief: {
        intent: "teach_practice",
        topic: "Client onboarding",
        audience: "consulting clients",
        desiredOutcome: "complete a first-week checklist",
        sourceNotes: "SECRET SOURCE NOTES from a private webinar transcript"
      },
      selectedPresets: {
        bookType: "workbook",
        lengthPreset: "standard",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "draft-1", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-draft",
        title: data.title,
        authorName: data.authorName ?? null,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-1", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-1/create-project",
      headers: bearer("token-a"),
      payload: {}
    });
    const createCall = mockPrisma.project.create.mock.calls.at(0)?.[0] as { data: Record<string, any> };
    const queuedCall = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, any> };

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: { id: "project-from-draft", bookType: "workbook" },
      operation: { projectId: "project-from-draft", status: "planning_queued", job: { id: "job-plan" } }
    });
    expect(createCall.data.prompt).toContain("Use the pasted source notes stored in the mobile creation metadata");
    expect(createCall.data.prompt).not.toContain("SECRET SOURCE NOTES");
    expect(createCall.data.mediaSettings.mobile).toMatchObject({
      bookType: "workbook",
      brief: expect.objectContaining({
        topic: "Client onboarding",
        sourceNotes: "SECRET SOURCE NOTES from a private webinar transcript"
      }),
      advisor: expect.objectContaining({
        recommendation: expect.objectContaining({ bookType: "workbook" })
      })
    });
    expect(queuedCall).toMatchObject({
      projectId: "project-from-draft",
      type: "PLAN_BOOK",
      payload: {
        inputSnapshot: expect.objectContaining({
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              brief: expect.objectContaining({ sourceNotes: expect.stringContaining("SECRET SOURCE NOTES") })
            })
          })
        })
      }
    });
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenLastCalledWith({
      where: { id: "draft-1" },
      data: expect.objectContaining({ status: "ACTIVE", createdProjectId: "project-from-draft" })
    });
    expect(JSON.stringify(response.json().project)).not.toMatch(/SECRET SOURCE NOTES|provider|model|mediaSettings|temperature/);
    await app.close();
  });

  it("leaves the committed durable job for outbox reconciliation when dispatch fails", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = creationPayload();
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "draft-1", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockResolvedValue(projectRecord({ id: "project-from-draft" }));
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-1", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    // Plan generation is free by default; this test prices it, the way an
    // operator can from the pricing dashboard, so a reservation exists.
    vi.mocked(reserveCredits).mockResolvedValueOnce({ id: "ledger-plan", status: "RESERVED" } as never);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    vi.mocked(dispatchGenerationJob).mockRejectedValueOnce(new Error("redis unavailable"));
    const app = await buildMobileApp({ advisorEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-1/create-project",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(vi.mocked(cancelUndispatchedGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(refundCreditLedgerEntry)).not.toHaveBeenCalled();
    expect(mockPrisma.project.delete).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the charge when the queued job cannot be proven dead", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = creationPayload();
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(creationDraftRecord({ id: "draft-1", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockResolvedValue(projectRecord({ id: "project-from-draft" }));
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-1", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(reserveCredits).mockResolvedValueOnce({ id: "ledger-plan", status: "RESERVED" } as never);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    vi.mocked(dispatchGenerationJob).mockRejectedValueOnce(new Error("row update lost after queue.add"));
    // The row was already claimed: the work will run, so the charge stands.
    vi.mocked(cancelUndispatchedGenerationJob).mockResolvedValueOnce(false);
    const app = await buildMobileApp({ advisorEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-1/create-project",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(vi.mocked(refundCreditLedgerEntry)).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates another output from a completed mobile creation chat", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "Workbook for new coaches",
      messages: [
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Workbook for new coaches" }
      ],
      selectedPresets: {
        bookType: "workbook",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({
        id: "draft-complete",
        status: "COMPLETED",
        createdProjectId: "project-old",
        payload,
        outputs: [
          {
            id: "output-old",
            draftId: "draft-complete",
            projectId: "project-old",
            title: "Old output",
            sequence: 1,
            createdAt: new Date("2026-06-15T10:00:00.000Z"),
            updatedAt: new Date("2026-06-15T10:00:00.000Z"),
            project: { title: "Old output", updatedAt: new Date("2026-06-15T10:00:00.000Z") }
          }
        ]
      })
    );
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-workbook" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-new",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        subcategory: data.subcategory ?? null,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.project.update.mockResolvedValue({});
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "draft-complete", payload, ...data })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan", projectId: "project-new" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-drafts/draft-complete/create-project",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: { id: "project-new" },
      output: { projectId: "project-new", sequence: 2 },
      operation: { projectId: "project-new", status: "planning_queued" }
    });
    expect(mockPrisma.mobileCreationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftId: "draft-complete",
          projectId: "project-new",
          sequence: 2
        })
      })
    );
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenLastCalledWith({
      where: { id: "draft-complete" },
      data: expect.objectContaining({ status: "ACTIVE", createdProjectId: "project-new" })
    });
    await app.close();
  });

});
