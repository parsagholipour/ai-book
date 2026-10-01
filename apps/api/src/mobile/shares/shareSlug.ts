import { randomBytes } from "node:crypto";

/**
 * A share slug: random base62, never derived from the title, the project id or
 * the user, so a link says nothing about the book and cannot be guessed from
 * another one. Twelve characters is ~71 bits.
 *
 * Uniqueness is the database's job, not this function's: every slug ever
 * issued is inserted into `ShareSlug`, whose primary key refuses a repeat, and
 * the minting transaction retries on that conflict (`mintShareSlugTx`).
 */
export const SHARE_SLUG_LENGTH = 12;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 248 = 62 * 4: bytes at or above it would bias the alphabet, so they are redrawn. */
const UNBIASED_LIMIT = 248;

export function generateShareSlug(length = SHARE_SLUG_LENGTH): string {
  let slug = "";
  while (slug.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < UNBIASED_LIMIT) {
        slug += BASE62[byte % 62];
        if (slug.length === length) break;
      }
    }
  }
  return slug;
}

/** What a `/s/<slug>` path segment must look like before any query runs. */
export const SHARE_SLUG_PATTERN = /^[0-9A-Za-z]{10,32}$/;

export function isShareSlug(value: string): boolean {
  return SHARE_SLUG_PATTERN.test(value);
}
