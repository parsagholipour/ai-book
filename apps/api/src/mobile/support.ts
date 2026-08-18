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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function fingerprintGenerationRequest(value: unknown): string {
  return hashString(JSON.stringify(sortJsonValue(value)));
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

export function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
