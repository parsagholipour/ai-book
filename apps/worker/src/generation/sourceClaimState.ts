import { createHash } from "node:crypto";
import type { SourceClaimReview } from "@book-maker/core";

export type StoredSourceClaimReview = SourceClaimReview & { textDigest: string };

/** Stable over pagination whitespace, sensitive to changes in the reviewed prose. */
export function sourceClaimDigest(markdown: string): string {
  return createHash("sha256").update(markdown.replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * The per-chapter claim review — inventory every factual assertion, verify it
 * against dossier passages, search for more, repair or delete what stays
 * unsupported — is off on every tier (Parsa, 2026-09-30: "we want best
 * looking results, we shouldn't waste tokens for this"). Measured on Quick
 * Draft books that day it was 100–300 s of every chapter, 50–70 claims a
 * history chapter with 0–26 supported, a repair that cut one chapter by 40%
 * and dropped the brief's own subject, and a "Review required" verdict on
 * every book, mostly for definitions, caveats and document titles. The
 * modules stay, tested, like the shelved arc; finalize and compile read the
 * same switch, so no stage re-runs the review or flags its absence.
 */
export const SOURCE_CLAIM_REVIEW = false;
