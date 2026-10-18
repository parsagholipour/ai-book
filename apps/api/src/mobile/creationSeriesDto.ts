import type { MobileCreationSessionDto } from "./dto.js";

/**
 * The series offer's wire shapes (`creationSeries.ts`), in a file of their own
 * because `dto.ts` is at its size budget.
 */

/** A finished book a creation chat's characters already appear in. */
export type MobileCreationSeriesBookDto = {
  projectId: string;
  title: string;
  /** The @-mentioned characters this book already has, as the book spelled them. */
  characterNames: string[];
  updatedAt: string;
};

/**
 * Whether the book this chat builds continues, or is inspired by, one of the
 * reader's finished books (`mobile/creationSeries.ts`). Null when there is
 * nothing to offer and nothing was answered.
 */
export type MobileCreationSeriesDto = {
  /** The finished books this chat's characters appear in, newest first. */
  books: MobileCreationSeriesBookDto[];
  /** What the reader answered, or null while the offer is open. */
  choice: { mode: "continuation" | "inspired" | "standalone"; projectId: string | null; title: string | null } | null;
};

/** Every session a route sends carries its series state (`serializeCreationSessionForUser`). */
export type MobileCreationSessionWithSeriesDto = MobileCreationSessionDto & { series: MobileCreationSeriesDto | null };
