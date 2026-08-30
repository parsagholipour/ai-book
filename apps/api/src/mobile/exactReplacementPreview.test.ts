import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import { planExactReplacement } from "./exactReplacementPreview.js";
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

describe("deterministic exact-replacement edits", () => {
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

  it("quotes a literal replacement at no credits and shows the real diff", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace rabbit with fly throughout the whole book." }
    });
    const proposal = response.json().reply.metadata.editProposal;

    expect(response.statusCode).toBe(200);
    expect(proposal).toMatchObject({ kind: "local_patch", credits: 0 });
    // The book writes "Rabbit"; the reader typed "rabbit". Preserving case is
    // what keeps this a string replacement instead of a page regeneration.
    expect(proposal.preview).toMatchObject({ kind: "exact_replace", from: "rabbit", to: "fly" });
    expect(proposal.preview.samples[0]).toEqual({
      pageIndex: 1,
      before: "Rabbit runs ahead at the start of the race.",
      after: "Fly runs ahead at the start of the race."
    });
    expect(proposal.preview.matchCount).toBeGreaterThan(0);
    await app.close();
  });

  it("charges nothing and tells the worker to stay mechanical when applied", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace rabbit with fly throughout the whole book." }
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().operation).toMatchObject({ kind: "local_patch", creditsCharged: 0 });
    // reserveCredits returns null at zero without touching the ledger, so the
    // amount is what matters here, not whether the call happened.
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(expect.objectContaining({ amountCredits: 0 }));
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          mode: "exact",
          exactReplacement: { from: "rabbit", to: "fly", preserveCase: true }
        })
      })
    );
    await app.close();
  });

  it("prices and queues a compound replacement for model generation and full review", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const instruction =
      'Replace "Rabbit" with "Fox" and make the tone darker throughout the whole book.';

    const proposed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: instruction }
    });
    const proposal = proposed.json().reply.metadata.editProposal;

    expect(proposed.statusCode).toBe(200);
    expect(proposal).toMatchObject({ kind: "local_patch" });
    expect(proposal.credits).toBeGreaterThan(0);
    expect(proposal.preview).toBeUndefined();

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });

    expect(confirmed.statusCode).toBe(200);
    const enqueue = vi.mocked(enqueueGenerationJob).mock.calls.at(-1)?.[0];
    expect(enqueue?.payload).toMatchObject({ editInstruction: instruction });
    expect(enqueue?.payload).not.toHaveProperty("exactReplacement");
    expect(enqueue?.payload).not.toHaveProperty("mode");
    await app.close();
  });

  it("keeps a page whose only match is the title and previews the rename", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // Page 2's markdown and summary no longer mention the term; only the title does.
    state.pages = editablePages().map((page) =>
      page.index === 2
        ? { ...page, markdown: "Turtle keeps walking to the finish line.", summary: "Turtle finishes." }
        : page
    );
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace rabbit with fly throughout the whole book." }
    });
    const proposal = response.json().reply.metadata.editProposal;

    expect(response.statusCode).toBe(200);
    expect(proposal).toMatchObject({ kind: "local_patch", credits: 0 });
    // The worker's exact-mode gate must agree, or this promised rename would be
    // silently skipped at apply time.
    expect(proposal.preview.samples).toContainEqual({
      pageIndex: 2,
      before: "Rabbit Learns",
      after: "Fly Learns"
    });
    await app.close();
  });

  it("ignores a match spanning the markdown/title seam when deciding case preservation", async () => {
    // Page 1 only "matches" if markdown and title are glued together; page 2
    // holds a real case-variant. The literal probe must not see the seam match,
    // or it would suppress the preserveCase fallback and lose page 2.
    state.pages = [
      {
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "Glow Stories",
        markdown: "Watch the sunset",
        summary: "Evening.",
        revision: 1
      },
      {
        id: "page-2",
        projectId: "project-1",
        index: 2,
        title: "Night Sky",
        markdown: "The Sunsetglow shimmered over the lake.",
        summary: "Night.",
        revision: 1
      }
    ];

    const plan = await planExactReplacement("project-1", { from: "sunsetGlow", to: "dusklight" }, [1, 2]);

    expect(plan).toMatchObject({
      replacement: { from: "sunsetGlow", to: "dusklight", preserveCase: true },
      pageIndexes: [2]
    });
  });

  it("asks instead of quoting a price when the text appears nowhere", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace wolverine with fly throughout the whole book." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("bookEditCreditCost", () => {
  it("only zeroes a local patch that was verified against the pages", () => {
    const project = projectRecord({ id: "project-1" }) as never;
    // Unverified: still the old per-page quote, because the worker may still
    // have to run the model on pages that do not contain the literal text.
    expect(bookEditCreditCost("local_patch", 2, project)).toBe(45);
    expect(bookEditCreditCost("local_patch", 2, project, { deterministic: true })).toBe(0);
    // A rewrite is a rewrite; the flag must never reach it.
    expect(bookEditCreditCost("page_rewrite", 12, project, { deterministic: true })).toBe(960);
  });

  it("quotes a replan against the book being asked for, not the one being replaced", () => {
    // A 12-page illustrated lead magnet: 120 replan base + 350 book base
    // + 12x8 pages + 2x45 interior images + 1x45 cover + 150 export.
    const project = projectRecord({ id: "project-1" }) as never;
    expect(bookEditCreditCost("book_replan", 0, project)).toBe(851);

    // "make it 3 pages without illustrations" — 120 + 350 + 3x8 + 1x45 cover + 150.
    // Quoted off the project row alone this stayed 851, so the reader paid for
    // nine pages and two illustrations the rebuilt book was never going to have.
    expect(
      bookEditCreditCost("book_replan", 0, project, {
        replanSettings: { targetPages: 3, fullIllustrations: false }
      })
    ).toBe(689);
  });
});
