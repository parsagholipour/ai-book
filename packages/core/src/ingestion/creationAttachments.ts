import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FileDigestAdapter } from "../adapters/fileUnderstanding.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import {
  decodeUtf8,
  DocumentTextError,
  extractDocxText,
  extractEpubText,
  normalizeExtractedText,
  stripHtml,
  stripRtf
} from "./documentText.js";

/**
 * Attachments uploaded into the creation chat (documents as source material,
 * photos as inspiration or transcribable notes). Each file is ingested exactly
 * once at upload time into a text digest; chat turns and the book build reuse
 * the digest so no per-turn vision or re-parsing cost is ever paid.
 */

export const creationAttachmentKindSchema = z.enum(["document", "photo"]);
export type CreationAttachmentKind = z.infer<typeof creationAttachmentKindSchema>;

/** Longest extracted/described content kept per attachment. */
export const CREATION_ATTACHMENT_CONTENT_MAX = 12000;
/** Longest one-line summary kept per attachment. */
export const CREATION_ATTACHMENT_SUMMARY_MAX = 700;
/** Most attachments a single creation chat can hold. */
export const CREATION_ATTACHMENT_MAX_COUNT = 8;
/** Upload size ceiling (bytes); route enforces it before buffering completes. */
export const CREATION_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const creationAttachmentSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: creationAttachmentKindSchema,
    name: z.string().trim().min(1).max(200),
    mimeType: z.string().trim().min(3).max(160),
    sizeBytes: z.number().int().min(0),
    summary: z.string().trim().max(CREATION_ATTACHMENT_SUMMARY_MAX).default(""),
    content: z.string().max(CREATION_ATTACHMENT_CONTENT_MAX).default(""),
    truncated: z.boolean().default(false),
    pages: z.number().int().min(1).max(5000).optional(),
    language: z.string().trim().min(2).max(40).optional(),
    createdAt: z.string().trim().min(1).max(40)
  })
  .strict();

export type CreationAttachment = z.infer<typeof creationAttachmentSchema>;

export type CreationAttachmentErrorCode =
  | "UNSUPPORTED_TYPE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "INGESTION_UNAVAILABLE"
  | "UNREADABLE_FILE";

export class CreationAttachmentError extends Error {
  readonly code: CreationAttachmentErrorCode;

  constructor(code: CreationAttachmentErrorCode, message: string) {
    super(message);
    this.name = "CreationAttachmentError";
    this.code = code;
  }
}

type AttachmentFormat = "image" | "pdf" | "docx" | "epub" | "html" | "rtf" | "text";

const IMAGE_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/heic": "image/heic",
  "image/heif": "image/heif",
  "image/bmp": "image/bmp"
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp"
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "srt",
  "log"
]);

export type DetectedAttachmentType = {
  kind: CreationAttachmentKind;
  format: AttachmentFormat;
  mimeType: string;
};

/**
 * Classifies a file by mime type with extension fallback. Returns null for
 * types we cannot read, so the route can answer with a friendly message.
 */
export function detectCreationAttachmentType(
  name: string,
  mimeType: string | undefined
): DetectedAttachmentType | null {
  const mime = mimeType?.trim().toLowerCase().split(";")[0] ?? "";
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

  const imageMime = IMAGE_MIME_TYPES[mime] ?? IMAGE_EXTENSIONS[extension];
  if (imageMime) {
    return { kind: "photo", format: "image", mimeType: imageMime };
  }
  if (mime === "application/pdf" || extension === "pdf") {
    return { kind: "document", format: "pdf", mimeType: "application/pdf" };
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    return {
      kind: "document",
      format: "docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
  }
  if (mime === "application/epub+zip" || extension === "epub") {
    return { kind: "document", format: "epub", mimeType: "application/epub+zip" };
  }
  if (mime === "text/html" || extension === "html" || extension === "htm") {
    return { kind: "document", format: "html", mimeType: "text/html" };
  }
  if (mime === "application/rtf" || mime === "text/rtf" || extension === "rtf") {
    return { kind: "document", format: "rtf", mimeType: "application/rtf" };
  }
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.has(extension)) {
    return { kind: "document", format: "text", mimeType: mime || "text/plain" };
  }
  return null;
}

export type IngestCreationAttachmentInput = {
  data: Buffer;
  name: string;
  mimeType?: string | undefined;
  /** Language the user chats in, so model-written summaries match. */
  language?: string | undefined;
};

export type IngestCreationAttachmentDeps = {
  /** Vision/PDF understanding; photos and PDFs fail gracefully without it. */
  fileDigest?: FileDigestAdapter | undefined;
  /** Cheap text model used only to summarize long extracted documents. */
  summaryModel?: TextModelAdapter | undefined;
  now?: (() => Date) | undefined;
  id?: (() => string) | undefined;
};

export async function ingestCreationAttachment(
  input: IngestCreationAttachmentInput,
  deps: IngestCreationAttachmentDeps = {}
): Promise<CreationAttachment> {
  const name = sanitizeAttachmentName(input.name);
  if (input.data.length === 0) {
    throw new CreationAttachmentError("EMPTY_FILE", "That file is empty, so there is nothing to read.");
  }
  if (input.data.length > CREATION_ATTACHMENT_MAX_BYTES) {
    throw new CreationAttachmentError(
      "FILE_TOO_LARGE",
      "That file is too large. Files up to 20 MB are supported."
    );
  }
  const detected = detectCreationAttachmentType(name, input.mimeType);
  if (!detected) {
    throw new CreationAttachmentError(
      "UNSUPPORTED_TYPE",
      "That file type isn't supported yet. Photos, PDF, Word (.docx), EPUB, and plain text or Markdown files work."
    );
  }

  const base = {
    id: deps.id?.() ?? `att_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    kind: detected.kind,
    name,
    mimeType: detected.mimeType,
    sizeBytes: input.data.length,
    createdAt: (deps.now?.() ?? new Date()).toISOString()
  };

  if (detected.format === "image" || detected.format === "pdf") {
    if (!deps.fileDigest) {
      throw new CreationAttachmentError(
        "INGESTION_UNAVAILABLE",
        detected.format === "image"
          ? "Reading photos isn't available right now. You can describe the photo in a message instead."
          : "Reading PDFs isn't available right now. You can paste the text into the chat instead."
      );
    }
    const digest = await deps.fileDigest.digestFile({
      data: input.data,
      mimeType: detected.mimeType,
      name,
      kind: detected.kind,
      language: input.language
    });
    const bounded = boundContent(digest.content);
    return creationAttachmentSchema.parse({
      ...base,
      summary: digest.summary.trim().slice(0, CREATION_ATTACHMENT_SUMMARY_MAX),
      content: bounded.content,
      truncated: bounded.truncated,
      ...(digest.pages ? { pages: digest.pages } : {}),
      ...(digest.language ? { language: digest.language } : {})
    });
  }

  const rawText = await extractLocalText(input.data, detected.format);
  const normalized = normalizeExtractedText(rawText);
  if (!normalized) {
    throw new CreationAttachmentError(
      "UNREADABLE_FILE",
      "No readable text was found in that file."
    );
  }
  const bounded = boundContent(normalized);
  const summary = await summarizeExtractedText(bounded.content, name, deps.summaryModel, input.language);
  return creationAttachmentSchema.parse({
    ...base,
    summary,
    content: bounded.content,
    truncated: bounded.truncated
  });
}

export function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment").slice(0, 200);
}

function boundContent(text: string): { content: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= CREATION_ATTACHMENT_CONTENT_MAX) {
    return { content: trimmed, truncated: false };
  }
  const slice = trimmed.slice(0, CREATION_ATTACHMENT_CONTENT_MAX);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  return {
    content: (lastBreak > CREATION_ATTACHMENT_CONTENT_MAX * 0.8 ? slice.slice(0, lastBreak) : slice).trimEnd(),
    truncated: true
  };
}

async function extractLocalText(data: Buffer, format: AttachmentFormat): Promise<string> {
  try {
    if (format === "docx") {
      return await extractDocxText(data);
    }
    if (format === "epub") {
      return await extractEpubText(data, { maxChars: CREATION_ATTACHMENT_CONTENT_MAX * 2 });
    }
    const text = decodeUtf8(data);
    if (format === "html") {
      return stripHtml(text);
    }
    if (format === "rtf") {
      return stripRtf(text);
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentTextError) {
      throw new CreationAttachmentError(error.code, error.message);
    }
    throw error;
  }
}

const attachmentSummaryAiSchema = z
  .object({ summary: z.string().min(1).max(CREATION_ATTACHMENT_SUMMARY_MAX) })
  .strict();

/** Short digests skip the model call entirely; long ones get one cheap summary. */
const SUMMARY_MODEL_THRESHOLD = 1500;

async function summarizeExtractedText(
  content: string,
  name: string,
  summaryModel: TextModelAdapter | undefined,
  language: string | undefined
): Promise<string> {
  if (content.length <= SUMMARY_MODEL_THRESHOLD || !summaryModel) {
    return fallbackSummary(content);
  }
  try {
    const result = await generateJsonWithRetry(summaryModel, {
      purpose: "creation-attachment-digest",
      temperature: 0.2,
      maxTokens: 300,
      schema: attachmentSummaryAiSchema,
      messages: [
        {
          role: "system",
          content:
            "Summarize the uploaded document for a book-writing assistant in 1-3 plain sentences: what it is and what it covers. Write in the document's own language." +
            (language ? ` If unclear, use the language "${language}".` : "")
        },
        {
          role: "user",
          content: `Document name: ${name}\n\n${content.slice(0, 9000)}`
        }
      ]
    });
    const summary = result.data.summary.trim();
    return summary ? summary.slice(0, CREATION_ATTACHMENT_SUMMARY_MAX) : fallbackSummary(content);
  } catch {
    return fallbackSummary(content);
  }
}

function fallbackSummary(content: string): string {
  const condensed = content.replace(/\s+/g, " ").trim();
  return condensed.length <= 300 ? condensed : `${condensed.slice(0, 297)}...`;
}
