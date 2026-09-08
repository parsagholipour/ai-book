import { describe, expect, it, vi } from "vitest";
import { creationAttachmentSchema } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: { sourceDocument: { findMany: vi.fn() } } }));
import { prisma } from "@book-maker/db";
import { foldCreationTranscriptTree, linearizeCreationMessages } from "../creationChatTree.js";
import { attachmentSourceRefs, hydrateSourceAttachments, sourceReadinessError, submittedAttachments } from "./sourceAttachments.js";
import type { MobileCreationMessage } from "../mobileCreation.js";

const attachment = (id: string) => creationAttachmentSchema.parse({ id, name: id, kind: "document", mimeType: "text/plain", sizeBytes: 100, createdAt: "2026-09-08" });
const ref = (id: string) => ({ id, kind: "document" as const, name: id });
describe("submitted sources", () => {
  it("blocks pending and unaccepted partial sources only on the submitted branch", () => {
    const file = { ...attachment("source"), sourceId: "source", extractionVersion: 1, processing: { status: "queued" as const, progress: 0, readableSections: 0, totalSections: 1, unreadable: [], retryable: false } };
    const messages: MobileCreationMessage[] = [{ role: "user", content: "Use it", attachments: [ref("source")] }];
    expect(sourceReadinessError([file], [])).toBeUndefined();
    expect(sourceReadinessError([file], messages)?.code).toBe("SOURCE_PROCESSING");
    const partial = { ...file, processing: { ...file.processing, status: "partial" as const } };
    expect(sourceReadinessError([partial], messages)?.code).toBe("SOURCE_REVIEW_REQUIRED");
    expect(sourceReadinessError([{ ...partial, processing: { ...partial.processing, acceptedPartial: true } }], messages)).toBeUndefined();
  });
  it("excludes unsent files and follows branch selection", () => {
    const files = [attachment("old"), attachment("new"), attachment("unsent")];
    const messages: MobileCreationMessage[] = [
      { id: "root", role: "assistant", content: "Hello" },
      { id: "a", parentId: "root", isActiveChild: false, role: "user", content: "A", attachments: [ref("old")] },
      { id: "b", parentId: "root", isActiveChild: true, role: "user", content: "B", attachments: [ref("new")] }
    ];
    expect(submittedAttachments(files, messages).map((file) => file.id)).toEqual(["new"]);
    messages[1]!.isActiveChild = true;
    messages[2]!.isActiveChild = false;
    expect(submittedAttachments(files, messages).map((file) => file.id)).toEqual(["old"]);
  });
  it("preserves the oldest attachment reference when its message folds away", () => {
    const messages: MobileCreationMessage[] = Array.from({ length: 180 }, (_, index) => ({ id: `m${index}`, parentId: index ? `m${index - 1}` : null, role: index % 2 ? "assistant" : "user", content: `Message ${index}`, ...(index === 0 ? { attachments: [ref("old")] } : {}) }));
    const folded = foldCreationTranscriptTree(messages, undefined);
    expect(folded.messages.some((message) => message.id === "m0")).toBe(false);
    expect(submittedAttachments([attachment("old")], linearizeCreationMessages(folded.messages).active)).toHaveLength(1);
  });
  it("loads processing independently and freezes the current extraction version", async () => {
    const file = { ...attachment("src_1"), sourceId: "src_1", extractionVersion: 1 };
    vi.mocked(prisma.sourceDocument.findMany).mockResolvedValue([{ id: "src_1", currentVersion: 2, extractions: [{ version: 2, status: "partial", summary: "Ending recovered", extractionComplete: true, totalSections: 20, checkpoints: [], unreadable: ["Page 8 unreadable"], acceptedPartial: true, progress: 100 }] }] as never);
    const [current] = await hydrateSourceAttachments("user1", [file]);
    expect(current!.processing).toMatchObject({ readableSections: 19, acceptedPartial: true, status: "partial" });
    expect(attachmentSourceRefs([current!])).toEqual([{ sourceId: "src_1", version: 2 }]);
    expect(prisma.sourceDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user1" }) }));
    expect(file.extractionVersion).toBe(1);
  });
  it("does not trust a cross-account source ID or its claimed ready status", async () => {
    vi.mocked(prisma.sourceDocument.findMany).mockResolvedValue([]);
    const [result] = await hydrateSourceAttachments("attacker", [{ ...attachment("foreign"), sourceId: "foreign", extractionVersion: 1, content: "untrusted client text", processing: { status: "ready", progress: 100, readableSections: 1, totalSections: 1, unreadable: [], retryable: false } }]);
    expect(result!.content).toBe("");
    expect(result!.processing).toBeUndefined();
  });
});
