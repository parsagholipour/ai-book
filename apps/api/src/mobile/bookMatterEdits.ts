import {
  BOOK_MATTER_LIMITS,
  BOOK_MATTER_TEXT_FIELDS,
  isAuthorManuscript,
  normalizeIsbn,
  normalizeNumerals,
  parseBookMatter,
  type BookMatter
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { resolvePlanTier } from "@book-maker/db/billing";
import { z } from "zod";
import { matterTextField } from "./authorProfile.js";
import { currentCoverKind, type CoverKind } from "./bookTitleEdits.js";
import {
  commitCoverChange,
  dispatchCoverJobs,
  ManuscriptCoverRefusal,
  type CommittedCoverChange,
  type CoverChange
} from "./coverChange.js";
import { imageSettingsFromMediaSettings } from "./imageSettings.js";
import { jsonInputValue } from "./support.js";
import { publishedTomezaCredit } from "./tomezaCredit.js";

/**
 * A book's own matter pages — the byline, the dedication, the publication
 * details and the About the Author page — read and changed from the book's
 * "Title & credits" sheet (`.scratch/book-matter/spec.md`).
 *
 * None of it is page text, so a change rewrites no page and costs nothing: on
 * a finished book it is one presentation commit (`commitCoverChange`, the
 * transaction a title change makes) with a free reprint; on a book still being
 * written it is a plain write the book's first compile reads. Which of the two
 * it is gets decided under the project row lock, on the row as it stands then,
 * because the first compile can publish between the route's read and the write.
 * A byline is also on the cover, which is set again over the picture it wears
 * where that is free (a design, or a drawn cover that kept its artwork); a drawn
 * cover from before artwork was kept says so rather than charging for a redraw
 * nobody asked for.
 *
 * An author's book takes its byline and dedication from the Writing Studio,
 * whose publish carries them into the book; writing them here would leave the
 * Studio's published record behind, so those two are refused (`SET_IN_STUDIO`).
 *
 * An ISBN is refused unless it is an ISBN-10 or ISBN-13 with a valid check
 * digit (`INVALID_ISBN`) — the copyright page prints "ISBN …" before whatever
 * is stored, so "hello" there reads as a number the book claims. The check is
 * the chat's own (`normalizeIsbn`); what is stored is the reader's spelling.
 */

/**
 * An ISBN as the reader typed it — their hyphens, spaces and digits — less a
 * leading "ISBN" or "ISBN-13:" label, because the copyright page prints "ISBN"
 * itself and would otherwise print it twice. The label is the one
 * `normalizeIsbn` (core `authoring/bookMatterChatEdit.ts`) takes off before its
 * check. A value that is nothing but the label is kept whole, so the check
 * refuses it rather than the field being cleared. The label's "10"/"13" is the
 * label's only when no digit follows it: "ISBN 1040123457" is an ISBN-10 whose
 * first two digits are 1 and 0, not "ISBN 10" and "40123457".
 */
function withoutIsbnLabel(value: string): string {
  // Numeral folding keeps UTF-16 offsets: read the label and its boundary in
  // ASCII, then take it off the original spelling without rewriting the ISBN.
  const label = normalizeNumerals(value).match(/^\s*isbn(?:[-\s]?1[03](?!\d))?\s*[:#]?\s*/i)?.[0];
  return value.slice(label?.length ?? 0) || value;
}

export const INVALID_ISBN_MESSAGE =
  "That ISBN isn’t valid. Check its digits, or leave the ISBN field empty.";

export const bookMatterPatchSchema = z
  .object({
    authorName: matterTextField(BOOK_MATTER_LIMITS.authorName, { singleLine: true }),
    dedication: matterTextField(BOOK_MATTER_LIMITS.dedication),
    aboutAuthor: matterTextField(BOOK_MATTER_LIMITS.aboutAuthor),
    authorWebsite: matterTextField(BOOK_MATTER_LIMITS.authorWebsite, { singleLine: true }),
    copyrightHolder: matterTextField(BOOK_MATTER_LIMITS.copyrightHolder, { singleLine: true }),
    imprint: matterTextField(BOOK_MATTER_LIMITS.imprint, { singleLine: true }),
    // The label comes off before the length is checked: it is not stored, so
    // "ISBN-13: 978-0-306-40615-7" (26 characters) is a 17-character ISBN.
    isbn: z.preprocess(
      (value) => (typeof value === "string" ? withoutIsbnLabel(value) : value),
      matterTextField(BOOK_MATTER_LIMITS.isbn, { singleLine: true })
    ),
    allRightsReserved: z.boolean().optional()
  })
  .strict();
export type BookMatterPatch = z.infer<typeof bookMatterPatchSchema>;

const nullableText = (maxLength: number) => ({ type: ["string", "null"], maxLength: maxLength * 4 });
export const bookMatterOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    authorName: nullableText(BOOK_MATTER_LIMITS.authorName),
    dedication: nullableText(BOOK_MATTER_LIMITS.dedication),
    aboutAuthor: nullableText(BOOK_MATTER_LIMITS.aboutAuthor),
    authorWebsite: nullableText(BOOK_MATTER_LIMITS.authorWebsite),
    copyrightHolder: nullableText(BOOK_MATTER_LIMITS.copyrightHolder),
    imprint: nullableText(BOOK_MATTER_LIMITS.imprint),
    isbn: nullableText(BOOK_MATTER_LIMITS.isbn),
    allRightsReserved: { type: "boolean" }
  }
} as const;

export type BookMatterDto = {
  authorName: string | null;
  dedication: string | null;
  aboutAuthor: string | null;
  authorWebsite: string | null;
  copyrightHolder: string | null;
  imprint: string | null;
  isbn: string | null;
  allRightsReserved: boolean;
  /** Whether the book's next compile prints the free tier's credit. */
  madeWithCredit: boolean;
  /**
   * Whether the book's published `book.md` prints it — what a subscriber asks
   * to have taken off (`tomezaCredit.ts`). False when nothing is published.
   */
  creditPrinted: boolean;
  /** An author's book: its byline and dedication are the Writing Studio's. */
  studioOwned: boolean;
};

export type BookMatterReprint = "queued" | "next_compile" | "none";
export type BookMatterCover = "retypeset" | "unchanged" | "keeps_old_name";

const nullableString = { type: ["string", "null"] } as const;
const bookMatterDtoSchema = {
  type: "object",
  properties: {
    authorName: nullableString,
    dedication: nullableString,
    aboutAuthor: nullableString,
    authorWebsite: nullableString,
    copyrightHolder: nullableString,
    imprint: nullableString,
    isbn: nullableString,
    allRightsReserved: { type: "boolean" },
    madeWithCredit: { type: "boolean" },
    creditPrinted: { type: "boolean" },
    studioOwned: { type: "boolean" }
  },
  required: [
    "authorName",
    "dedication",
    "aboutAuthor",
    "authorWebsite",
    "copyrightHolder",
    "imprint",
    "isbn",
    "allRightsReserved",
    "madeWithCredit",
    "creditPrinted",
    "studioOwned"
  ]
} as const;

export const bookMatterResponseSchema = {
  type: "object",
  properties: { bookMatter: bookMatterDtoSchema },
  required: ["bookMatter"]
} as const;

export const bookMatterPatchResponseSchema = {
  type: "object",
  properties: {
    bookMatter: bookMatterDtoSchema,
    reprint: { type: "string", enum: ["queued", "next_compile", "none"] },
    cover: { type: "string", enum: ["retypeset", "unchanged", "keeps_old_name"] }
  },
  required: ["bookMatter", "reprint", "cover"]
} as const;

export const bookMatterRemoveCreditResponseSchema = {
  type: "object",
  properties: {
    bookMatter: bookMatterDtoSchema,
    reprint: { type: "string", enum: ["queued", "none"] }
  },
  required: ["bookMatter", "reprint"]
} as const;

export const bookMatterProjectSelect = {
  id: true,
  userId: true,
  status: true,
  authorName: true,
  bookMatter: true,
  mediaSettings: true,
  currentPlanId: true
} as const;

export type BookMatterProject = {
  id: string;
  userId: string;
  status: string;
  authorName: string | null;
  bookMatter: unknown;
  mediaSettings: unknown;
  currentPlanId: string | null;
};

export async function ownedBookMatterProject(userId: string, projectId: string): Promise<BookMatterProject | null> {
  return prisma.project.findFirst({ where: { id: projectId, userId }, select: bookMatterProjectSelect });
}

export async function serializeBookMatter(project: BookMatterProject): Promise<BookMatterDto> {
  const matter = parseBookMatter(project.bookMatter);
  const [tier, creditPrinted] = await Promise.all([resolvePlanTier(project.userId), publishedTomezaCredit(project)]);
  return {
    authorName: project.authorName?.trim() || null,
    dedication: matter.dedication ?? null,
    aboutAuthor: matter.aboutAuthor ?? null,
    authorWebsite: matter.authorWebsite ?? null,
    copyrightHolder: matter.copyrightHolder ?? null,
    imprint: matter.imprint ?? null,
    isbn: matter.isbn ?? null,
    allRightsReserved: matter.allRightsReserved === true,
    madeWithCredit: tier === "free",
    // An unreadable store reads as not printed: the sheet still opens, and a
    // removal asked for anyway reprints (`removeTomezaCredit`). EDITING reads
    // as not printed too: the rebuild under way reads the plan again.
    creditPrinted: creditPrinted === true,
    studioOwned: isAuthorManuscript(project.mediaSettings)
  };
}

/** The text a patch sets, keyed by its wire name, for the content screen. */
export function bookMatterPatchText(patch: BookMatterPatch): Record<string, string | null | undefined> {
  return {
    authorName: patch.authorName,
    dedication: patch.dedication,
    aboutAuthor: patch.aboutAuthor,
    authorWebsite: patch.authorWebsite,
    copyrightHolder: patch.copyrightHolder,
    imprint: patch.imprint,
    isbn: patch.isbn
  };
}

/** The book's matter with the patch laid over it: `null` clears a page, absent keeps it. */
export function patchedBookMatter(current: BookMatter, patch: BookMatterPatch): BookMatter {
  const next: BookMatter = { ...current };
  for (const field of BOOK_MATTER_TEXT_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  if (patch.allRightsReserved === true) next.allRightsReserved = true;
  if (patch.allRightsReserved === false) delete next.allRightsReserved;
  return next;
}

export class BookMatterRefusal extends Error {
  constructor(
    readonly code: "PROJECT_BUSY" | "SET_IN_STUDIO" | "INVALID_ISBN",
    message: string
  ) {
    super(message);
  }
}

const SETTLED_STATUSES = new Set(["COMPLETE", "REVIEW_REQUIRED"]);
const BUSY_MESSAGE = "Your book is being updated. Try again in a moment.";
const FINISHING_MESSAGE = "Your book is being put together right now. Try again in a minute.";

type BookMatterOutcome = { reprint: BookMatterReprint; cover: BookMatterCover };

/**
 * Applies a patch, or throws `BookMatterRefusal`. Writes nothing when the patch
 * changes nothing, so a repeated save never reprints the book.
 *
 * `project` is the route's read and names the book; everything the decision
 * rests on — the status, the byline, the matter, the plan — is read again
 * under the project row lock (`SELECT … FOR UPDATE`, Project first, the order
 * every edit and the compile's publication take it in). Decided off the route's
 * read, a first compile that published in between left a book COMPLETE with its
 * files already out, a row written behind them, and a reply promising
 * `next_compile` — a compile that never comes.
 */
export async function applyBookMatterPatch(project: BookMatterProject, patch: BookMatterPatch): Promise<BookMatterOutcome> {
  // Asked of the value alone, so before any lock. `null` and `""` (already
  // `null` here) clear the ISBN and are never refused.
  if (patch.isbn && !normalizeIsbn(patch.isbn)) {
    throw new BookMatterRefusal("INVALID_ISBN", INVALID_ISBN_MESSAGE);
  }
  let decided: { outcome: BookMatterOutcome; committed?: CommittedCoverChange };
  try {
    decided = await prisma.$transaction((tx) => applyUnderLock(tx, project.id, patch));
  } catch (error) {
    if (error instanceof ManuscriptCoverRefusal) {
      throw new BookMatterRefusal("PROJECT_BUSY", BUSY_MESSAGE);
    }
    throw error;
  }
  if (decided.committed) {
    await dispatchCoverJobs(project.id, decided.committed);
  }
  return decided.outcome;
}

async function applyUnderLock(
  tx: Prisma.TransactionClient,
  projectId: string,
  patch: BookMatterPatch
): Promise<{ outcome: BookMatterOutcome; committed?: CommittedCoverChange }> {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  const live = await tx.project.findUnique({ where: { id: projectId }, select: bookMatterProjectSelect });
  if (!live) {
    // Deleted since the route read it; the next read answers 404.
    throw new BookMatterRefusal("PROJECT_BUSY", BUSY_MESSAGE);
  }
  // Asked of the locked row: a takeover can make a book the author's after
  // the route read it.
  if (isAuthorManuscript(live.mediaSettings) && (patch.authorName !== undefined || patch.dedication !== undefined)) {
    throw new BookMatterRefusal(
      "SET_IN_STUDIO",
      "This book’s author name and dedication are set in the Writing Studio’s book settings, and reach the book when you update it."
    );
  }
  const current = parseBookMatter(live.bookMatter);
  const next = patchedBookMatter(current, patch);
  const currentAuthor = live.authorName?.trim() || null;
  const nextAuthor = patch.authorName === undefined ? currentAuthor : patch.authorName;
  const authorChanged = nextAuthor !== currentAuthor;
  const matterChanged = JSON.stringify(next) !== JSON.stringify(current);
  if (!authorChanged && !matterChanged) {
    return { outcome: { reprint: "none", cover: "unchanged" } };
  }

  if (SETTLED_STATUSES.has(live.status) && live.currentPlanId) {
    return reprintSettledBook(tx, projectId, { next, authorChanged, nextAuthor });
  }
  if (live.status === "EDITING") {
    throw new BookMatterRefusal("PROJECT_BUSY", BUSY_MESSAGE);
  }
  // Still being written (or failed, or never generated): the first compile
  // reads the row, so the row is all there is to write — unless that compile
  // is already queued or running, because it reads (or read) the row when it
  // starts and would publish without the change.
  //
  // A new GenerationJob's Project foreign key takes FOR KEY SHARE, which
  // conflicts with our FOR UPDATE. If this count finds no compile, an enqueue
  // waits for our commit before inserting its row and dispatching the worker.
  // If insertion wins, our lock waits and this count sees the open compile.
  const openCompiles = await tx.generationJob.count({
    where: { projectId, type: "COMPILE_EXPORT", status: { in: ["QUEUED", "ACTIVE"] } }
  });
  if (openCompiles > 0) {
    throw new BookMatterRefusal("PROJECT_BUSY", FINISHING_MESSAGE);
  }
  await tx.project.update({
    where: { id: projectId },
    data: { bookMatter: jsonInputValue(next), ...(authorChanged ? { authorName: nextAuthor } : {}) }
  });
  if (!authorChanged) {
    return { outcome: { reprint: "next_compile", cover: "unchanged" } };
  }
  // A cover already typeset is set again before the first compile when its
  // words drift from the row or it recorded none (the worker's
  // `coverTypesetDrift`), over its design or kept artwork; a cover not drawn
  // yet is typeset from the row when it is — if the book draws one at all.
  const willDrawCover = imageSettingsFromMediaSettings(live.mediaSettings).coverArtSource !== "none";
  return { outcome: { reprint: "next_compile", cover: coverAfterBylineChange(await currentCoverKind(projectId, tx), willDrawCover) } };
}

/** On a finished book, inside the lock `applyUnderLock` holds: `commitCoverChange` re-takes it in the same transaction. */
async function reprintSettledBook(
  tx: Prisma.TransactionClient,
  projectId: string,
  options: { next: BookMatter; authorChanged: boolean; nextAuthor: string | null }
): Promise<{ outcome: BookMatterOutcome; committed: CommittedCoverChange }> {
  const coverKind: CoverKind = options.authorChanged ? await currentCoverKind(projectId, tx) : "none";
  const change: CoverChange = {
    bookMatter: options.next,
    ...(options.authorChanged ? { authorName: options.nextAuthor } : {}),
    // Both kinds use the retypeset handler, which never draws character
    // references or new artwork. Keep the design source in the plan too.
    ...(coverKind === "design" ? { coverArtSource: "design" as const, drawCover: { purchase: false, retypeset: true } } : {}),
    ...(coverKind === "ai-kept" ? { drawCover: { purchase: false, retypeset: true } } : {})
  };
  const committed = await commitCoverChange(tx, projectId, change);
  // A finished book draws no new cover here, so one it lacks stays lacking.
  return { outcome: { reprint: "queued", cover: coverAfterBylineChange(coverKind, false) }, committed };
}

/**
 * What a new byline does to the cover. `coverToCome` is whether a cover not
 * drawn yet will be: it is typeset from the row when it runs.
 */
function coverAfterBylineChange(kind: CoverKind, coverToCome: boolean): BookMatterCover {
  switch (kind) {
    case "design":
    case "ai-kept":
      return "retypeset";
    case "ai":
      return "keeps_old_name";
    case "upload":
      return "unchanged";
    case "none":
      return coverToCome ? "retypeset" : "unchanged";
  }
}
