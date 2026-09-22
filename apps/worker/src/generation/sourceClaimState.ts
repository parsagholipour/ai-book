import { createHash } from "node:crypto";
import type { SourceClaimReview } from "@book-maker/core";

export type StoredSourceClaimReview = SourceClaimReview & { textDigest: string };

/** Stable over pagination whitespace, sensitive to changes in the reviewed prose. */
export function sourceClaimDigest(markdown: string): string {
  return createHash("sha256").update(markdown.replace(/\s+/g, " ").trim()).digest("hex");
}
