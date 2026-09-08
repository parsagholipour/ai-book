import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CREATION_ATTACHMENT_MAX_BYTES, loadConfig, creationAttachmentSchema, detectCreationAttachmentType, sanitizeAttachmentName, type CreationAttachment, type SourceRef } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { mobileCreationDraftPayloadSchema, type MobileCreationMessage } from "../mobileCreation.js";
import { linearizeCreationMessages } from "../creationChatTree.js";

export function submittedAttachments(attachments: CreationAttachment[], messages: MobileCreationMessage[]): CreationAttachment[] {
  const ids = new Set(linearizeCreationMessages(messages).active.flatMap((message) => (message.attachments ?? []).map((ref) => ref.id)));
  return attachments.filter((attachment) => ids.has(attachment.id));
}
export function attachmentSourceRefs(attachments: CreationAttachment[]): SourceRef[] {
  return attachments.flatMap((attachment) => attachment.sourceId && attachment.extractionVersion ? [{ sourceId: attachment.sourceId, version: attachment.extractionVersion }] : []);
}
export function sourceReadinessError(attachments: CreationAttachment[], messages: MobileCreationMessage[]) {
  for (const attachment of submittedAttachments(attachments, messages).filter((attachment) => attachment.sourceId)) {
    const state = attachment.processing;
    if (!state || ["queued", "extracting", "summarizing"].includes(state.status)) return { code: "SOURCE_PROCESSING", message: `Still reading ${attachment.name}. You can keep chatting and build when reading finishes.` };
    if (state.status !== "ready" && !(["partial", "limited"].includes(state.status) && state.acceptedPartial)) return { code: "SOURCE_REVIEW_REQUIRED", message: `${attachment.name} could not be read completely. Retry it or choose to use its readable content before building.` };
  }
  return undefined;
}
export async function hydrateSourceAttachments(userId: string, attachments: CreationAttachment[]): Promise<CreationAttachment[]> {
  if (!attachments.length || (!attachments.some((attachment) => attachment.sourceId) && !loadConfig().FULL_DOCUMENT_SOURCES)) return attachments;
  const documents = await prisma.sourceDocument.findMany({ where: { userId, id: { in: attachments.map((attachment) => attachment.sourceId ?? attachment.id) } }, include: { extractions: { select: { version: true, status: true, summary: true, unreadable: true, progress: true, totalSections: true, extractionComplete: true, checkpoints: true, acceptedPartial: true, error: true } } } });
  return attachments.map((attachment) => {
    const document = documents.find((row) => row.id === (attachment.sourceId ?? attachment.id));
    const extraction = document?.extractions.find((row) => row.version === document.currentVersion);
    if (!document || !extraction) return attachment.sourceId ? { ...attachment, summary: "Source unavailable", content: "", processing: undefined } : attachment;
    const checkpoints = Array.isArray(extraction.checkpoints) ? extraction.checkpoints : [];
    const gaps = extraction.extractionComplete
      ? (Array.isArray(extraction.unreadable) ? extraction.unreadable.filter((value): value is string => typeof value === "string") : [])
      : checkpoints.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.unreadable === "string" ? [entry.unreadable] : []);
    return creationAttachmentSchema.parse({ ...attachment, content: "", sourceId: document.id, extractionVersion: extraction.version, summary: extraction.summary.slice(0, 700),
      processing: { acceptedPartial: extraction.acceptedPartial, status: extraction.status, progress: extraction.progress, totalSections: extraction.totalSections,
        readableSections: Math.max(0, (extraction.extractionComplete ? extraction.totalSections : checkpoints.length) - gaps.length), unreadable: gaps, retryable: ["failed", "partial", "limited"].includes(extraction.status),
        ...(extraction.error ? { error: extraction.error } : {}) } });
  });
}

export class SourceUploadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export async function saveSourceUpload(options: { userId: string; draftId: string; root: string; data: Buffer; filename: string; mimeType?: string | undefined; requestId?: string | undefined; expectedRevision?: number | undefined }) {
  if (!options.data.length || options.data.length > CREATION_ATTACHMENT_MAX_BYTES) throw new SourceUploadError("FILE_TOO_LARGE", "Send a non-empty file up to 20 MB.");
  const type = detectCreationAttachmentType(options.filename, options.mimeType);
  if (!type) throw new SourceUploadError("UNSUPPORTED_TYPE", "That file type is not supported.");
  const hash = createHash("sha256").update(options.data).digest("hex");
  const uploadKey = options.requestId ?? hash;
  const id = `src_${createHash("sha256").update(`${options.draftId}:${uploadKey}`).digest("hex").slice(0, 32)}`;
  // Exclusive write prevents a retry reusing its key with different bytes from changing an original.
  await mkdir(join(options.root, options.draftId), { recursive: true });
  const path = join(options.root, options.draftId, id);
  try { await writeFile(path, options.data, { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const existingHash = createHash("sha256").update(await readFile(path)).digest("hex");
    if (existingHash !== hash) throw new SourceUploadError("REQUEST_CONFLICT", "That upload request was already used for another file.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MobileCreationDraft" WHERE "id" = ${options.draftId} AND "userId" = ${options.userId} FOR UPDATE`;
    const draft = await tx.mobileCreationDraft.findFirstOrThrow({ where: { id: options.draftId, userId: options.userId } });
    const payload = mobileCreationDraftPayloadSchema.parse(draft.payload);
    const existing = await tx.sourceDocument.findUnique({ where: { id } });
    if (existing) {
      if (existing.contentHash !== hash) throw new SourceUploadError("REQUEST_CONFLICT", "That request already belongs to another file.");
      const attachment = payload.attachments?.find((attachment) => attachment.id === id);
      if (!attachment) throw new SourceUploadError("ATTACHMENT_REMOVED", "That upload was removed. Start a new upload request.");
      return { attachment, revision: draft.revision };
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== draft.revision) throw new SourceUploadError("SESSION_CONFLICT", "This chat changed. Reload it before uploading.");
    if ((payload.attachments?.length ?? 0) >= 8) throw new SourceUploadError("ATTACHMENT_LIMIT", "This chat already has eight files. Remove one before adding another.");
    const attachment = creationAttachmentSchema.parse({ id, sourceId: id, extractionVersion: 1, kind: type.kind, name: sanitizeAttachmentName(options.filename), mimeType: type.mimeType, sizeBytes: options.data.length, createdAt: new Date().toISOString(),
      processing: { status: "queued", progress: 0, readableSections: 0, totalSections: 0, unreadable: [], retryable: false } });
    await tx.sourceDocument.create({ data: { id, userId: options.userId, draftId: options.draftId, storageDraftId: options.draftId, uploadKey, contentHash: hash, name: attachment.name, mimeType: type.mimeType, kind: type.kind, sizeBytes: options.data.length, extractions: { create: { version: 1 } } } });
    await tx.mobileCreationDraft.update({ where: { id: draft.id }, data: { payload: { ...payload, attachments: [...(payload.attachments ?? []), attachment] }, revision: { increment: 1 } } });
    return { attachment, revision: draft.revision + 1 };
  });
}

export async function waitForSourceUpload(userId: string, attachment: CreationAttachment): Promise<CreationAttachment> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const [current] = await hydrateSourceAttachments(userId, [attachment]);
    if (current && !["queued", "extracting", "summarizing"].includes(current.processing?.status ?? "ready")) return current;
    await delay(750);
  }
  throw new SourceUploadError("SOURCE_PROCESSING", "The file is still being read. Retry this upload request to check it again.");
}

export async function retrySourceUpload(userId: string, draftId: string, sourceId: string, requestId: string, expectedVersion?: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "SourceDocument" WHERE "id" = ${sourceId} AND "userId" = ${userId} AND "draftId" = ${draftId} FOR UPDATE`;
    const source = await tx.sourceDocument.findFirstOrThrow({ where: { id: sourceId, userId, draftId }, include: { extractions: { include: { chunks: true } } } });
    if (source.extractions.some((row) => row.retryKey === requestId)) return;
    if (expectedVersion !== undefined && source.currentVersion !== expectedVersion) throw new SourceUploadError("SOURCE_CHANGED", "This file has changed. Refresh its reading status before retrying.");
    const previous = source.extractions.find((row) => row.version === source.currentVersion)!;
    if (!["failed", "partial", "limited"].includes(previous.status)) return;
    const reuseExtraction = previous.extractionComplete && previous.status !== "limited" && (!Array.isArray(previous.unreadable) || previous.unreadable.length === 0);
    if (!reuseExtraction) {
      try { await readFile(join(loadConfig().ATTACHMENT_STORAGE_DIR, source.storageDraftId, source.id)); }
      catch { throw new SourceUploadError("ATTACHMENT_FILE_EXPIRED", "The original file has expired. Its readable passages remain available."); }
    }
    const version = source.currentVersion + 1;
    await tx.sourceExtraction.create({ data: { sourceId, version, retryKey: requestId, extractionComplete: reuseExtraction, fullContent: previous.fullContent, totalSections: previous.totalSections, checkpoints: previous.checkpoints ?? [], unreadable: previous.unreadable ?? [],
      chunks: { create: previous.chunks.map(({ ordinal, section, locator, content, summary, embedding }) => ({ ordinal, section, locator, content, summary, ...(embedding ? { embedding } : {}) })) } } });
    await tx.sourceDocument.update({ where: { id: sourceId }, data: { currentVersion: version } });
  });
}
