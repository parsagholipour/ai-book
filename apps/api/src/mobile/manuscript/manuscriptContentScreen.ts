import type { FastifyReply } from "fastify";
import {
  assessContentRestrictions,
  ContentRestrictedError,
  contentRestrictedError,
  copyrightRestrictionsEnabled,
  sendContentRestricted,
  type ContentRestrictionAssessment,
  type ContentRestrictionRefusal
} from "../../contentRestrictions.js";
import { chapterHasUnpublishedChanges, type PublishedMeta } from "./manuscriptStore.js";

/**
 * The Writing Studio's content screen: the same preflight every other surface
 * runs, at the moments an author's own text leaves the private working copy.
 *
 * **The policy is the app's, not a stricter one.** The screen is
 * `assessContentRestrictions` (`apps/api/src/contentRestrictions.ts`) with the
 * same operator copyright flag: a local, deterministic regex preflight — two
 * always-on rules (a fake official document meant to pass as genuine; content
 * that facilitates severe illegal harm) and the operator's optional copyright
 * rule. It makes no model call and costs microseconds; the one query behind it
 * is the flag. Ambiguous text is allowed, so an author's mature fiction passes
 * exactly as the same words would in the chat.
 *
 * **A chapter is screened in windows the size of a request.** Those rules are
 * co-occurrence tests over the whole string ("passport" anywhere *and* "fake"
 * anywhere), written against what a reader types — the chat's 5,000-character
 * message, a 2,000-character character description — and `normalize` reads
 * only the first 50,000 characters. A chapter holds up to 200,000. Screened
 * whole it would refuse a thriller whose first scene checks a passport and
 * whose last mentions a fake smile — stricter by length alone — and never read
 * its last 150,000 characters. So a chapter is read in overlapping
 * `MANUSCRIPT_SCREEN_WINDOW_CHARS` windows a half-window apart: any passage up
 * to 2,500 characters sits whole inside one window, and two phrases within
 * 2,500 characters of each other always share one.
 *
 * **Where it runs, and where it does not:**
 * - **Publish** — the moment the text becomes the book people read, share and
 *   export. Only what changed since the last publish: every printed chapter
 *   with unpublished edits (title + markdown), and the book-level fields that
 *   differ from `settings.published`. It runs *under the publish lock, on the
 *   rows the publish is about to write* — the text a write screens is the text
 *   it stores; a pre-read would miss an autosave that lands before the lock.
 *   The flag is read before the transaction opens, as the character routes do,
 *   because it is a query on another pool connection.
 * - **Settings writes and book creation** — title, subtitle, author, dedication
 *   and art style (the art style is a prompt the picture model reads). Short
 *   fields, screened together like a creation draft's, before anything loads.
 * - **Not autosave.** The working copy is private and unshared, a refused
 *   autosave would throw away the author's words, and publish reads the same
 *   text before anyone else can.
 * - **Not the pictures.** Nothing in this app moderates image bytes — a
 *   character photo is stored as uploaded, and `readCharacterPhoto` screens
 *   only the *words* a vision call writes about it. A published book is
 *   reportable (`POST /api/mobile/projects/:id/reports`) like any other.
 * - The AI assists screen the author's *typed request* (instruction, picture
 *   prompt, draft notes) in `routes/manuscriptAssists.ts`, as the book chat
 *   screens its message; the selection they work on is the author's text and
 *   is screened when it is published.
 *
 * **A refusal is the existing 422** — the screen's own code, message and
 * reason (`sendContentRestricted`), plus `chapters` (`{chapterId, title}`, in
 * reading order) and `fields` (the book-level fields refused), so the app can
 * take the author to the words. Publish throws it from inside its transaction:
 * nothing is written, nothing is charged, the working copy is untouched and the
 * requestId is not spent.
 *
 * **Failure is closed, as everywhere else.** The screen cannot be "down"; the
 * flag read can fail, and like every screening route this lets that throw, so
 * the request fails with nothing written rather than publishing unscreened.
 */

/** The largest message a reader types to the model in one go (the book chat's cap). */
export const MANUSCRIPT_SCREEN_WINDOW_CHARS = 5_000;
const MANUSCRIPT_SCREEN_STEP_CHARS = MANUSCRIPT_SCREEN_WINDOW_CHARS / 2;

/** The book-level text the Studio stores, in the order a reader meets it. */
export const STUDIO_SCREENED_FIELDS = ["title", "subtitle", "authorName", "dedication", "artStyle"] as const;
export type StudioScreenedField = (typeof STUDIO_SCREENED_FIELDS)[number];
export type StudioFieldText = Partial<Record<StudioScreenedField, string | null | undefined>>;

export type RefusedChapter = { chapterId: string; title: string };

/**
 * A Studio refusal. It is a `ContentRestrictedError` — the whole refusal, not a
 * flattened code — plus where in the book the words are.
 */
export class ManuscriptContentRefusal extends ContentRestrictedError {
  constructor(
    refusal: ContentRestrictionRefusal,
    readonly chapters: RefusedChapter[],
    readonly fields: StudioScreenedField[]
  ) {
    super(refusal);
    this.name = "ManuscriptContentRefusal";
  }
}

/** Screens text of any length, one request-sized window at a time. */
export function assessManuscriptText(text: string, copyrightRestrictions: boolean): ContentRestrictionAssessment {
  const options = { copyrightRestrictionsEnabled: copyrightRestrictions };
  for (let start = 0; ; start += MANUSCRIPT_SCREEN_STEP_CHARS) {
    const assessment = assessContentRestrictions(text.slice(start, start + MANUSCRIPT_SCREEN_WINDOW_CHARS), options);
    if (!assessment.allowed || start + MANUSCRIPT_SCREEN_WINDOW_CHARS >= text.length) {
      return assessment;
    }
  }
}

/**
 * The fields screened as one string, the way a creation draft's are; when the
 * refusal came only from two fields together, all of them are named.
 */
function screenFields(
  values: StudioFieldText,
  copyrightRestrictions: boolean
): { refusal: ContentRestrictionRefusal; fields: StudioScreenedField[] } | null {
  const entries = STUDIO_SCREENED_FIELDS.flatMap((field) => {
    const text = values[field]?.trim();
    return text ? [{ field, text }] : [];
  });
  if (entries.length === 0) return null;
  const options = { copyrightRestrictionsEnabled: copyrightRestrictions };
  const joint = assessContentRestrictions(entries.map((entry) => entry.text).join("\n"), options);
  if (joint.allowed) return null;
  const alone = entries.filter((entry) => !assessContentRestrictions(entry.text, options).allowed);
  return { refusal: joint, fields: (alone.length > 0 ? alone : entries).map((entry) => entry.field) };
}

/**
 * The settings and creation gate: screens the fields the body carries, answers
 * the 422 itself and says whether the route may go on — the shape of
 * `enforceContentRestrictions`, for the Studio's refusal body.
 */
export async function enforceStudioFieldRestrictions(reply: FastifyReply, values: StudioFieldText): Promise<boolean> {
  // A goal- or cast-only write carries no text, and costs no flag read.
  if (!STUDIO_SCREENED_FIELDS.some((field) => values[field]?.trim())) return true;
  const refused = screenFields(values, await copyrightRestrictionsEnabled());
  if (!refused) return true;
  sendManuscriptContentRefusal(reply, new ManuscriptContentRefusal(refused.refusal, [], refused.fields));
  return false;
}

/**
 * The publish gate, run under the publish lock on the rows about to be written.
 * Throws so the refusal rolls the transaction back; every refused chapter is
 * named, and the book-level refusal (read first) supplies the sentence when
 * there is one.
 */
export function assertPublishContentAllowed(
  input: {
    /** Live chapters in reading order. */
    chapters: ReadonlyArray<{
      id: string;
      title: string;
      markdown: string;
      revision: number;
      publishedRevision: number | null;
      wordCount: number;
    }>;
    /** Working chapters that print at least one page. */
    printedChapterIds: ReadonlySet<string>;
    published: PublishedMeta | null;
    meta: PublishedMeta;
  },
  copyrightRestrictions: boolean
): void {
  const changedFields: StudioFieldText = {};
  for (const field of STUDIO_SCREENED_FIELDS) {
    if (input.published === null || input.published[field] !== input.meta[field]) {
      changedFields[field] = input.meta[field];
    }
  }
  const fields = screenFields(changedFields, copyrightRestrictions);
  let first: ContentRestrictionRefusal | null = fields?.refusal ?? null;
  const chapters: RefusedChapter[] = [];
  for (const chapter of input.chapters) {
    if (!input.printedChapterIds.has(chapter.id) || !chapterHasUnpublishedChanges(chapter)) continue;
    const assessment = assessManuscriptText(`${chapter.title}\n${chapter.markdown}`, copyrightRestrictions);
    if (!assessment.allowed) {
      first ??= assessment;
      chapters.push({ chapterId: chapter.id, title: chapter.title.trim() });
    }
  }
  if (first) {
    throw new ManuscriptContentRefusal(first, chapters, fields?.fields ?? []);
  }
}

export function sendManuscriptContentRefusal(reply: FastifyReply, error: ManuscriptContentRefusal): FastifyReply {
  return sendContentRestricted(reply, error.refusal, { chapters: error.chapters, fields: error.fields });
}

/**
 * The serializer's copy of that body, for the Studio routes that can answer
 * it. It has to name `chapters` and `fields`, or fast-json-stringify drops them
 * exactly as it once dropped `reason` (`contentRestrictedError`).
 */
export const manuscriptContentRestrictedError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        ...contentRestrictedError.properties.error.properties,
        chapters: {
          type: "array",
          items: {
            type: "object",
            properties: { chapterId: { type: "string" }, title: { type: "string" } },
            required: ["chapterId", "title"]
          }
        },
        fields: { type: "array", items: { type: "string" } }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;
