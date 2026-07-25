import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  mockAccessTokens,
  mockPrisma,
  originalEnv
} from "./testing/mobileApiHarness.js";

describe("creation chat attachments API", () => {
  let tempAttachmentStorageDir: string | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    tempAttachmentStorageDir = mkdtempSync(join(tmpdir(), "book-maker-mobile-attachments-"));
    process.env = { ...originalEnv, ATTACHMENT_STORAGE_DIR: tempAttachmentStorageDir };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempAttachmentStorageDir) {
      rmSync(tempAttachmentStorageDir, { recursive: true, force: true });
      tempAttachmentStorageDir = null;
    }
  });

  const readyAttachment = {
    id: "att_ready1",
    kind: "document" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 64,
    summary: "Pricing notes for consultants.",
    content: "Anchor high and offer three tiers.",
    truncated: false,
    createdAt: "2026-07-06T00:00:00.000Z"
  };
  const sessionPayload = {
    payloadVersion: 3,
    rawIdea: "A pricing guide",
    messages: [
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "A pricing guide" }
    ]
  };

  it("uploads a file, digests it, and persists it on the draft", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const ingestion = vi.fn().mockResolvedValue(readyAttachment);
    const app = await buildMobileApp({ attachmentIngestion: ingestion });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/attachments?filename=notes.txt&mimeType=text%2Fplain",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: Buffer.from("Anchor high and offer three tiers.", "utf8")
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      attachment: { id: "att_ready1", kind: "document", name: "notes.txt", pages: null }
    });
    // Digested text stays server-side.
    expect(JSON.stringify(response.json())).not.toContain("Anchor high");
    expect(ingestion).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes.txt", mimeType: "text/plain" })
    );
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { attachments: Array<Record<string, unknown>> } };
    };
    expect(updateCall.data.payload.attachments).toHaveLength(1);
    expect(updateCall.data.payload.attachments[0]).toMatchObject({ id: "att_ready1", content: "Anchor high and offer three tiers." });
    // Original bytes are kept server-side so the file follows the account across devices.
    const storedPath = join(tempAttachmentStorageDir!, "session-draft", "att_ready1");
    expect(readFileSync(storedPath, "utf8")).toBe("Anchor high and offer three tiers.");
    expect(response.json().attachment.url).toBe(
      "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file"
    );
    await app.close();
  });

  it("serves the stored original file and 404s once it is gone", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = { ...sessionPayload, attachments: [readyAttachment] };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload })
    );
    const fileDir = join(tempAttachmentStorageDir!, "session-draft");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(join(fileDir, "att_ready1"), "original bytes");
    const app = await buildMobileApp();

    const served = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file",
      headers: bearer("token-a")
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("text/plain");
    expect(served.body).toBe("original bytes");

    rmSync(join(fileDir, "att_ready1"));
    const expired = await app.inject({
      method: "GET",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1/file",
      headers: bearer("token-a")
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({ error: { code: "ATTACHMENT_FILE_EXPIRED" } });
    await app.close();
  });

  it("returns friendly errors for unsupported files", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    const { CreationAttachmentError } = await import("@book-maker/core");
    const app = await buildMobileApp({
      attachmentIngestion: vi.fn().mockRejectedValue(
        new CreationAttachmentError("UNSUPPORTED_TYPE", "That file type isn't supported yet.")
      )
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/attachments?filename=song.mp3",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3])
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "UNSUPPORTED_TYPE" } });
    await app.close();
  });

  it("binds uploaded attachments to a chat message and acknowledges them", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = { ...sessionPayload, attachments: [readyAttachment] };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "", attachmentIds: ["att_ready1"] }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.turn.assistantMessage).toContain("notes.txt");
    expect(body.session.attachments).toHaveLength(1);
    const updateCall = mockPrisma.mobileCreationDraft.update.mock.calls.at(0)?.[0] as {
      data: { payload: { messages: Array<Record<string, unknown>>; attachments: Array<Record<string, unknown>> } };
    };
    const userMessages = updateCall.data.payload.messages.filter((message) => message.role === "user");
    expect(userMessages.at(-1)).toMatchObject({
      attachments: [{ id: "att_ready1", kind: "document", name: "notes.txt" }]
    });
    expect(updateCall.data.payload.attachments).toHaveLength(1);
    await app.close();
  });

  it("rejects messages that reference unknown attachments", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(
      creationDraftRecord({ id: "session-draft", payload: sessionPayload })
    );
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/messages",
      headers: bearer("token-a"),
      payload: { message: "Use my file", attachmentIds: ["att_missing"] }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_NOT_FOUND" } });
    await app.close();
  });

  it("removes unsent attachments but protects ones already in the conversation", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-a" });
    const sentRef = { id: "att_ready1", kind: "document", name: "notes.txt" };
    const payloadWithSent = {
      ...sessionPayload,
      messages: [...sessionPayload.messages, { role: "user", content: "", attachments: [sentRef] }],
      attachments: [readyAttachment, { ...readyAttachment, id: "att_unsent", name: "draft.md" }]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload: payloadWithSent })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", ...data })
    );
    const fileDir = join(tempAttachmentStorageDir!, "session-draft");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(join(fileDir, "att_unsent"), "unsent bytes");
    writeFileSync(join(fileDir, "att_ready1"), "sent bytes");
    const app = await buildMobileApp();

    const removeUnsent = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_unsent",
      headers: bearer("token-a")
    });
    const removeSent = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1",
      headers: bearer("token-a")
    });

    expect(removeUnsent.statusCode).toBe(200);
    expect(existsSync(join(fileDir, "att_unsent"))).toBe(false);
    expect(removeSent.statusCode).toBe(409);
    expect(removeSent.json()).toMatchObject({ error: { code: "ATTACHMENT_IN_USE" } });
    expect(existsSync(join(fileDir, "att_ready1"))).toBe(true);
    await app.close();
  });

  it("protects attachments referenced only by an inactive chat branch", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const sentRef = { id: "att_ready1", kind: "document", name: "notes.txt" };
    // The message carrying the attachment sits on an abandoned branch.
    const payloadWithFork = {
      ...sessionPayload,
      messages: [
        { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi!" },
        { id: "m1", parentId: "m0", isActiveChild: false, role: "user", content: "", attachments: [sentRef] },
        { id: "m2", parentId: "m0", isActiveChild: true, role: "user", content: "No file after all" }
      ],
      attachments: [readyAttachment]
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "session-draft", payload: payloadWithFork })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/creation-sessions/session-draft/attachments/att_ready1",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_IN_USE" } });
    await app.close();
  });
});
