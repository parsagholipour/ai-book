import { type MobileJsonValue } from "./dto.js";
import { Prisma } from "@book-maker/db";
import { createHash } from "node:crypto";

/**
 * Small pure helpers (JSON coercion, text clipping, hashing) used across the
 * mobile modules.
 */

export function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function jsonValue(value: unknown): MobileJsonValue {
  return JSON.parse(JSON.stringify(value)) as MobileJsonValue;
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function fingerprintGenerationRequest(value: unknown): string {
  return hashString(JSON.stringify(sortJsonValue(value)));
}

/**
 * An `ImageAsset`'s URL with its version on it: `?v=` names the row and the
 * file it points at, so the URL moves whenever the bytes behind it can and
 * stays put otherwise (a stable URL is what lets a client cache the picture).
 *
 * Both halves are needed. A drawn cover is rewritten at one path
 * (`cover.<ext>`) under a *new* row, and a replaced page picture keeps its
 * row but points it at a *new* file. Metadata is deliberately left out: a
 * move or a keeper-token rebind rewrites it without touching a byte.
 */
export function versionedImageAssetUrl(url: string, asset: { id: string; path: string }): string {
  const version = createHash("sha256").update(`${asset.id}\n${asset.path}`).digest("base64url").slice(0, 12);
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }
  return value;
}

export function cleanTargetLanguage(language: string | null | undefined): string | null {
  const trimmed = language?.trim();
  return trimmed ? trimmed.slice(0, 40) : null;
}

export function languageDisplayName(language: string): string {
  return language === "en" ? "English" : language;
}

export function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export function previewText(value: string): string {
  return clipText(value, 180);
}

/**
 * A book's prompt as the reader would describe it, for the summary.
 *
 * A book made in the creation chat stores the planner's instruction
 * (`composeMobileProjectPrompt`): "Create a short story. Book type choice: … Creation
 * chat: Assistant: Hi! …", and 180 characters of that end before the reader has said
 * a word. The shelf searches this field "by title, author or topic", so a story
 * asked for as "an old lighthouse keeper" was not found by "lighthouse". The
 * preview is the first line the reader wrote, else the stored idea; a prompt
 * someone typed is previewed as it was.
 */
export function promptPreviewText(prompt: string): string {
  const transcript = /(?:^|\n)Creation chat:\s*/.exec(prompt);
  if (transcript) {
    const firstUserLine = /(?:^|\n)User(?: \([^)\n]*\))?:[ \t]*([^\n]*\S[^\n]*)/.exec(
      prompt.slice(transcript.index + transcript[0].length)
    );
    if (firstUserLine?.[1]) {
      return previewText(firstUserLine[1]);
    }
  }
  const idea = /(?:^|\n)Original idea:[ \t]*([^\n]*\S[^\n]*)/.exec(prompt);
  return previewText(idea?.[1] ?? prompt);
}

/**
 * A page's text as one readable line for the book page's preview.
 *
 * Block by block, because the preview is prose: a heading ends its own
 * sentence ("…keeps slipping. It is Sunday…" rather than "…keeps slipping It is
 * Sunday…"), fenced blocks (code, a figure's JSON) and table delimiter rows are
 * dropped, a table row reads as its cells, and only markup is removed — the old
 * pass stripped every `-` and `_`, so "one-hour" previewed as "one hour".
 */
export function markdownPlainText(markdown: string): string {
  const withoutFences = markdown.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "");
  const lines = withoutFences.split(/\r?\n/).flatMap((raw) => {
    let line = raw.trim();
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) return [];
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) return [];
    if (line.startsWith("|")) {
      line = line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ");
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[1]!.trim();
      return [/[.!?:…]$/.test(text) ? text : `${text}.`];
    }
    return [line.replace(/^(>\s*)+/, "").replace(/^([-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "")];
  });
  return lines
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|\*|`)(?=\S)([^*`]*?\S)\1/g, "$2")
    .replace(/(^|\s)_(\S[^_]*?\S|\S)_(?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `clipText` for a chat reply, which the app renders as light markdown: line
 * breaks are the markdown. `clipText` folds them into spaces, and every
 * grounded answer reached the reader as one paragraph of "… - **A** … - **B**".
 */
export function clipReplyText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const clipped = normalized.slice(0, maxLength);
  const lastBreak = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("\n"));
  const minBreak = Math.floor(maxLength * 0.65);
  return `${clipped.slice(0, lastBreak > minBreak ? lastBreak : maxLength).trim()}...`;
}

export function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const clipped = normalized.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  const minBreak = Math.floor(maxLength * 0.65);
  return `${clipped.slice(0, lastSpace > minBreak ? lastSpace : maxLength).trim()}...`;
}

export function generatedPagePreview(markdown: string, summary: string): string {
  const plain = markdownPlainText(markdown);
  return clipText(plain || summary, 900);
}

export function sanitizeDownloadFilename(title: string): string {
  const clean = title
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return clean || "book";
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Re-exported rather than re-written: `@book-maker/core` owns the one record
 * coercion, so hardening it (rejecting class instances, say) reaches every
 * workspace at once. Kept on this module because ~20 mobile files already read
 * their Prisma `Json` columns through `support.js`.
 */
export { jsonRecord } from "@book-maker/core";

export function isPrismaUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
