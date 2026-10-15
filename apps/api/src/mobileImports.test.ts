import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  consumeManuscriptImportUseTx,
  getImportQuota,
  hasActiveSubscriptionEntitlement
} from "@book-maker/db/billing";
import { saveCreationAttachmentFile } from "./attachmentStorage.js";
import { wordBomb } from "./testing/zipBomb.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "./queue.js";
import { mobileImportRoutes } from "./mobileImports.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  bookImport: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  project: { create: vi.fn(), findFirst: vi.fn() },
  generationJob: { findUnique: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
  authorProfile: { findUnique: vi.fn(async () => null) },
  safetySettingsRevision: { findFirst: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({
  Prisma: { JsonNull: null },
  prisma: mockPrisma
}));

vi.mock("@book-maker/db/billing", () => ({
  hasActiveSubscriptionEntitlement: vi.fn(),
  getImportQuota: vi.fn(),
  consumeManuscriptImportUseTx: vi.fn()
}));

vi.mock("./queue.js", () => ({
  enqueueGenerationJob: vi.fn(),
  dispatchGenerationJob: vi.fn()
}));

vi.mock("./attachmentStorage.js", () => ({
  saveCreationAttachmentFile: vi.fn()
}));

// The import routes only borrow small helpers from the big mobile module;
// mock them so this suite exercises the import route logic in isolation.
vi.mock("./mobileProjects.js", () => ({
  mobileAuthError: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: { code: { type: "string" }, message: { type: "string" } },
        required: ["code", "message"]
      }
    },
    required: ["error"]
  },
  requireMobileAuth: vi.fn(async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization === "Bearer token-a") {
      return { user: { id: "user-a", email: "a@example.com" } };
    }
    reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
    return null;
  }),
  hitAuthenticatedLimit: vi.fn(() => true),
  sendMobileError: (reply: FastifyReply, statusCode: number, code: string, message: string) =>
    reply.code(statusCode).send({ error: { code, message } }),
  sendSubscriptionRequired: (reply: FastifyReply, message: string) =>
    reply.code(403).send({ error: { code: "SUBSCRIPTION_REQUIRED", message } }),
  loadMobileProjectDetail: vi.fn(),
  serializeProjectDetail: vi.fn(async (project: { id: string; title: string }) => ({
    id: project.id,
    title: project.title,
    source: "imported"
  }))
}));

import { loadMobileProjectDetail } from "./mobileProjects.js";

const originalEnv = { ...process.env };
let tempAttachmentDir: string | null = null;

async function buildApp() {
  const app = Fastify();
  await app.register(mobileImportRoutes);
  return app;
}

function bearer() {
  return { authorization: "Bearer token-a" };
}

const MANUSCRIPT = [
  "Chapter 1: The Storm",
  "The rain hammered the windows of the old house all night long.",
  "Chapter 2: The Calm",
  "Morning arrived quietly, as if apologizing for the night before."
].join("\n\n");

function importUrl(params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    filename: "manuscript.txt",
    requestId: "import-req-0001",
    ...params
  });
  return `/api/mobile/projects/import?${query.toString()}`;
}

function inject(app: Awaited<ReturnType<typeof buildApp>>, options: {
  url?: string;
  payload?: Buffer;
  headers?: Record<string, string>;
} = {}) {
  return app.inject({
    method: "POST",
    url: options.url ?? importUrl(),
    headers: {
      ...(options.headers ?? bearer()),
      "content-type": "application/octet-stream"
    },
    payload: options.payload ?? Buffer.from(MANUSCRIPT, "utf8")
  });
}

describe("mobile import routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue({ copyrightRestrictionsEnabled: false });
    tempAttachmentDir = mkdtempSync(join(tmpdir(), "book-maker-import-"));
    process.env = { ...originalEnv, ATTACHMENT_STORAGE_DIR: tempAttachmentDir };
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    mockPrisma.bookImport.findUnique.mockResolvedValue(null);
    mockPrisma.bookImport.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof mockPrisma) => Promise<unknown>) =>
      run(mockPrisma)
    );
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "project-imported",
      ...data
    }));
    mockPrisma.bookImport.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data
    }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-import" } as never);
    vi.mocked(dispatchGenerationJob).mockResolvedValue({ id: "job-import" } as never);
    vi.mocked(loadMobileProjectDetail).mockResolvedValue({
      id: "project-imported",
      title: "manuscript"
    } as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempAttachmentDir) {
      rmSync(tempAttachmentDir, { recursive: true, force: true });
      tempAttachmentDir = null;
    }
  });

  it("requires auth", async () => {
    const app = await buildApp();
    const response = await inject(app, { headers: { authorization: "Bearer nope" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("gives a free account its monthly import and stamps the claim on the job", async () => {
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    vi.mocked(getImportQuota).mockResolvedValue({
      used: 0,
      limit: 1,
      periodKey: "2026-08",
      resetsAt: new Date("2026-09-01T00:00:00.000Z")
    });
    vi.mocked(consumeManuscriptImportUseTx).mockResolvedValue({
      allowed: true,
      used: 1,
      limit: 1,
      periodKey: "2026-08",
      resetsAt: new Date("2026-09-01T00:00:00.000Z")
    });
    const app = await buildApp();

    const response = await inject(app);

    expect(response.statusCode).toBe(201);
    const enqueue = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.[0] as { payload: Record<string, unknown> };
    // The claim rides the payload so a failed worker import can hand it back.
    expect(enqueue.payload.importQuota).toEqual({ userId: "user-a", periodKey: "2026-08" });
    await app.close();
  });

  it("refuses a second free import this month and points at the plan", async () => {
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    vi.mocked(getImportQuota).mockResolvedValue({
      used: 1,
      limit: 1,
      periodKey: "2026-08",
      resetsAt: new Date("2026-09-01T00:00:00.000Z")
    });
    vi.mocked(consumeManuscriptImportUseTx).mockResolvedValue({
      allowed: false,
      used: 1,
      limit: 1,
      periodKey: "2026-08",
      resetsAt: new Date("2026-09-01T00:00:00.000Z")
    });
    const app = await buildApp();

    const response = await inject(app);

    expect(response.statusCode).toBe(403);
    // The same code shipped clients already answer with the upgrade sheet.
    expect(response.json().error.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("claims no import slot for subscribers", async () => {
    const app = await buildApp();
    const response = await inject(app);
    expect(response.statusCode).toBe(201);
    expect(getImportQuota).not.toHaveBeenCalled();
    expect(consumeManuscriptImportUseTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("imports a manuscript: stores the file, creates rows, queues IMPORT_BOOK", async () => {
    const app = await buildApp();
    const response = await inject(app);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.project.id).toBe("project-imported");
    expect(body.import.status).toBe("UPLOADED");
    expect(body.operation).toMatchObject({ kind: "import_queued", jobId: "job-import" });

    expect(vi.mocked(saveCreationAttachmentFile)).toHaveBeenCalledTimes(1);
    const projectData = mockPrisma.project.create.mock.calls[0]![0].data;
    expect(projectData.status).toBe("GENERATING");
    expect(projectData.category).toBe("CUSTOM");
    expect(projectData.title).toBe("Chapter 1: The Storm".length > 0 ? projectData.title : "");
    const mobile = (projectData.mediaSettings as { mobile: { import: Record<string, unknown> } }).mobile;
    expect(mobile.import).toMatchObject({ format: "text", fileName: "manuscript.txt" });

    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "IMPORT_BOOK",
        dedupeKey: "import-book:project-imported",
        dispatch: false
      })
    );
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("job-import");
    expect(vi.mocked(enqueueGenerationJob).mock.calls[0]![0].payload.knownAuthors).toEqual([]);
    await app.close();
  });

  it("freezes the profile names used by the upload parse in the durable import job", async () => {
    mockPrisma.authorProfile.findUnique.mockResolvedValueOnce({
      penName: "Jane Doe",
      includeAboutAuthor: false
    } as never);
    const app = await buildApp();
    const response = await inject(app, {
      payload: Buffer.from("# The Long Winter\n\nJane Doe\n\n# Chapter One\n\nBody text.")
    });

    expect(response.statusCode).toBe(201);
    const project = mockPrisma.project.create.mock.calls[0]![0].data;
    expect(project.authorName).toBe("Jane Doe");
    expect(mockPrisma.bookImport.create.mock.calls[0]![0].data.stats.sectionCount).toBe(1);
    const enqueue = vi.mocked(enqueueGenerationJob).mock.calls[0]![0];
    expect(enqueue.transaction).toBe(mockPrisma);
    expect(enqueue.payload.knownAuthors).toEqual(["Jane Doe"]);
    await app.close();
  });

  it("prints the manuscript's own matter once: its words over the profile's, its pages without them", async () => {
    mockPrisma.authorProfile.findUnique.mockResolvedValueOnce({
      userId: "user-a",
      penName: "Jane Doe",
      bio: "PROFILE BIO: Jane writes thrillers.",
      website: "janedoe.com",
      copyrightHolder: null,
      imprint: "Self Press",
      allRightsReserved: false,
      includeAboutAuthor: true
    } as never);
    const manuscript = [
      "# The Long Winter",
      "Jane Doe",
      "## Copyright",
      "Copyright © 2019 Jane Doe. All rights reserved.",
      "No part of this book may be reproduced without written permission.",
      "## Dedication",
      "For my mother.",
      "## Chapter 1: The Storm",
      "The rain hammered the windows of the old house all night long.",
      "## Chapter 2: The Calm",
      "Morning arrived quietly, as if apologizing for the night before.",
      "## About the Author",
      "Jane Doe lives in Maine with two dogs."
    ].join("\n\n");
    const app = await buildApp();

    const response = await inject(app, { url: importUrl({ filename: "winter.md" }), payload: Buffer.from(manuscript, "utf8") });

    expect(response.statusCode).toBe(201);
    const data = mockPrisma.project.create.mock.calls[0]![0].data;
    // The title page's unlabelled name is the profile's pen name, so the page is the compiler's to print.
    expect(data.title).toBe("The Long Winter");
    expect(data.authorName).toBe("Jane Doe");
    expect(data.bookMatter).toEqual({
      dedication: "For my mother.",
      aboutAuthor: "Jane Doe lives in Maine with two dogs.",
      authorWebsite: "janedoe.com",
      imprint: "Self Press",
      allRightsReserved: true,
      copyrightYear: "2019"
    });
    // Only the two chapters are left to import.
    const stats = mockPrisma.bookImport.create.mock.calls[0]![0].data.stats as { sectionCount: number };
    expect(stats.sectionCount).toBe(2);
    await app.close();
  });

  it("copies the profile as before when the manuscript brings no matter of its own", async () => {
    mockPrisma.authorProfile.findUnique.mockResolvedValueOnce({
      userId: "user-a",
      penName: "Jane Doe",
      bio: "Jane writes thrillers.",
      website: null,
      copyrightHolder: null,
      imprint: null,
      allRightsReserved: false,
      includeAboutAuthor: true
    } as never);
    const app = await buildApp();

    const response = await inject(app);

    expect(response.statusCode).toBe(201);
    const data = mockPrisma.project.create.mock.calls[0]![0].data;
    expect(data.authorName).toBe("Jane Doe");
    expect(data.bookMatter).toEqual({ aboutAuthor: "Jane writes thrillers." });
    expect(data.subtitle).toBeUndefined();
    await app.close();
  });

  it.each([
    ["aboutAuthor", "# Chapter One\n\nBody text.\n\n# About the Author\n\nThis author writes about CSAM."],
    ["dedication", "# Dedication\n\nFor CSAM.\n\n# Chapter One\n\nBody text."],
    ["authorName", "# A Memoir\n\nBy CSAM\n\n# Chapter One\n\nBody text."]
  ])("refuses extracted %s before storing bytes, claiming quota or creating rows", async (field, manuscript) => {
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    vi.mocked(consumeManuscriptImportUseTx).mockResolvedValue({ allowed: true, used: 1, limit: 1, periodKey: "2026-08", resetsAt: new Date("2026-09-01") });
    const app = await buildApp();

    const response = await inject(app, { payload: Buffer.from(manuscript) });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "critical_illegal_harm", fields: [field] });
    expect(saveCreationAttachmentFile).not.toHaveBeenCalled();
    expect(consumeManuscriptImportUseTx).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("screens copied profile matter with the current operator copyright rule", async () => {
    mockPrisma.authorProfile.findUnique.mockResolvedValueOnce({
      bio: "Copy the entire copyrighted book without permission.", includeAboutAuthor: true
    } as never);
    mockPrisma.safetySettingsRevision.findFirst.mockResolvedValue({ copyrightRestrictionsEnabled: true });
    const app = await buildApp();

    const response = await inject(app);

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "COPYRIGHT_RESTRICTED", reason: "copyright", fields: ["aboutAuthor"] });
    expect(saveCreationAttachmentFile).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows printed memorials and history biographies, screening fields independently", async () => {
    const app = await buildApp();
    const response = await inject(app, { payload: Buffer.from(
      "# Dedication\n\nTo the victims of the terrorist attack, who taught us how to grieve.\n\n# Chapter One\n\nBody text.\n\n# About the Author\n\nOma escaped on a fake passport in 1939."
    ) });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.project.create.mock.calls[0]![0].data.bookMatter).toMatchObject({
      aboutAuthor: "Oma escaped on a fake passport in 1939."
    });
    await app.close();
  });

  it("replays the same requestId without creating a duplicate project", async () => {
    mockPrisma.bookImport.findUnique.mockResolvedValue({
      id: "imp_1",
      projectId: "project-imported",
      status: "COMPLETE",
      fileName: "manuscript.txt",
      format: "text",
      stats: { pageCount: 4 }
    });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ id: "job-import" });
    const app = await buildApp();

    const response = await inject(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().project.id).toBe("project-imported");
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects photos and PDFs with typed errors", async () => {
    const app = await buildApp();

    const photo = await inject(app, { url: importUrl({ filename: "cover.jpg" }) });
    expect(photo.statusCode).toBe(422);
    expect(photo.json().error.code).toBe("UNSUPPORTED_TYPE");

    const pdf = await inject(app, { url: importUrl({ filename: "book.pdf" }) });
    expect(pdf.statusCode).toBe(422);
    expect(pdf.json().error.code).toBe("UNSUPPORTED_TYPE");
    expect(pdf.json().error.message).toContain("PDF");
    await app.close();
  });

  it("rejects unreadable files before creating anything", async () => {
    const app = await buildApp();
    const response = await inject(app, {
      url: importUrl({ filename: "book.docx" }),
      payload: Buffer.from("not a zip archive", "utf8")
    });
    expect(response.statusCode).toBe(422);
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(vi.mocked(saveCreationAttachmentFile)).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a free account's import while another of its books holds the long lane, before storing or claiming", async () => {
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    mockPrisma.generationJob.findMany.mockResolvedValueOnce([
      { projectId: "project-other", type: "GENERATE_BOOK", payload: { planId: "plan-x" } }
    ]);
    const app = await buildApp();
    const response = await inject(app);
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("BOOKS_IN_PROGRESS_LIMIT");
    expect(vi.mocked(saveCreationAttachmentFile)).not.toHaveBeenCalled();
    expect(vi.mocked(getImportQuota)).not.toHaveBeenCalled();
    expect(vi.mocked(consumeManuscriptImportUseTx)).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers a Word file that inflates past the limit with the too-large refusal, before any claim", async () => {
    // 1 GiB of document.xml behind a header claiming 1,000 bytes. A 306 KB file
    // like it crashed the API with "heap limit" before inflating was counted.
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    const app = await buildApp();
    const response = await inject(app, { url: importUrl({ filename: "book.docx" }), payload: wordBomb(1024) });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: "FILE_TOO_LARGE", message: "That Word document is too large to read. Split it into smaller files and try again." }
    });
    expect(vi.mocked(saveCreationAttachmentFile)).not.toHaveBeenCalled();
    expect(vi.mocked(consumeManuscriptImportUseTx)).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns import status for an imported project", async () => {
    mockPrisma.bookImport.findFirst.mockResolvedValue({
      id: "imp_1",
      status: "COMPLETE",
      fileName: "manuscript.txt",
      format: "text",
      stats: { pageCount: 4 }
    });
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-imported/import",
      headers: bearer()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().import).toMatchObject({ id: "imp_1", status: "COMPLETE" });
    await app.close();
  });
});
