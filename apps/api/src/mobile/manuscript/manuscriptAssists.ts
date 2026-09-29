import {
  creditPricing,
  jsonRecord,
  modelTierFromMediaSettings,
  tierPrice,
  tierPriceKey,
  type BillingOperation,
  type CreditPricing,
  type ModelTier
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { addImageQuotaLimit } from "../addImageOperations.js";
import { fingerprintGenerationRequest, jsonInputValue } from "../support.js";
import { newRowId } from "./manuscriptBook.js";
import type { ManuscriptProject } from "./manuscriptDerivation.js";
import type {
  ManuscriptAssistDto,
  ManuscriptAssistKind,
  ManuscriptAssistNoteDto,
  ManuscriptAssistResultDto,
  ManuscriptAssistStatus
} from "./manuscriptDto.js";
import type { ManuscriptAssistCreateBody } from "./manuscriptSchemas.js";
import { liveChapters, manuscriptSource, type LoadedManuscript } from "./manuscriptStore.js";

/**
 * The Writing Studio's long assists (spec "Long assists"): an illustration, a
 * chapter draft, margin notes, a whole-book consistency check and an outline,
 * each one `ManuscriptAssist` row worked by a detached `WRITING_ASSIST` job.
 *
 * **Pricing reuses existing keys and ledger operations** — no new
 * `CreditOperation`, no new price key — and the app mirrors the formulas
 * (`studio_pricing.dart`), so they are spelled out once, here, and pinned with
 * literal totals in the tests.
 *
 * **Charging** is the `startGenerationAttempt` skeleton: the reservation, the
 * commit, the assist row and the durable job row are one serializable commit,
 * the job is dispatched after it, and a replayed `requestId` answers the row
 * it already made. The worker settles through the attempt — `markCompleted`
 * commits it, `markFailed`/`markStopped` refund it — and an illustration's
 * free-tier slot rides the reservation as `metadata.imageQuota`, so every one
 * of those refunds returns it too.
 */

/** Wire kind → the row's kind. Only these five are the author's; STYLE_PROFILE and REEMBED are internal. */
const ROW_KIND: Record<ManuscriptAssistKind, string> = {
  illustrate: "ILLUSTRATE",
  draft_chapter: "DRAFT_CHAPTER",
  chapter_feedback: "CHAPTER_FEEDBACK",
  consistency: "CONSISTENCY",
  outline: "OUTLINE"
};

const WIRE_KIND: Record<string, ManuscriptAssistKind> = Object.fromEntries(
  Object.entries(ROW_KIND).map(([wire, row]) => [row, wire as ManuscriptAssistKind])
);

export const AUTHOR_FACING_ASSIST_KINDS = Object.values(ROW_KIND);

const OPEN_STATUSES = ["QUEUED", "RUNNING", "READY"];

const OPERATION: Record<ManuscriptAssistKind, BillingOperation> = {
  illustrate: "IMAGE_GENERATION",
  draft_chapter: "PAGE_REGENERATION",
  chapter_feedback: "BOOK_TEXT_EDIT",
  consistency: "PREMIUM_REVIEW",
  outline: "PLAN_GENERATION"
};

const DESCRIPTION: Record<ManuscriptAssistKind, string> = {
  illustrate: "Writing Studio illustration",
  draft_chapter: "Writing Studio chapter draft",
  chapter_feedback: "Writing Studio chapter notes",
  consistency: "Writing Studio consistency check",
  outline: "Writing Studio outline"
};

export const DEFAULT_DRAFT_TARGET_WORDS = 1500;
/** Words the price counts as one page of a draft. */
const DRAFT_WORDS_PER_PAGE = 350;
const DRAFT_MAX_BILLED_PAGES = 15;
/** Characters the price counts as one page of a chapter read for notes — the paginator's page target. */
const FEEDBACK_CHARS_PER_PAGE = 1900;

export class ManuscriptAssistRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * What one assist costs. The app computes the same numbers from the same
 * formulas; change both together.
 *
 * - illustrate: `tierPrice(imageGeneration)` for its one picture;
 * - draft_chapter: `clamp(ceil(targetWords / 350), 1, 15)` pages at
 *   `tierPrice(pageRegenerationPerPage)`;
 * - chapter_feedback: `bookTextEditBase` + `max(1, ceil(chars / 1900))` pages
 *   at `tierPrice(bookTextEditPerPage)`, over the working-copy markdown;
 * - consistency: the flat `premiumReview`;
 * - outline: the initial-plan rate for the tier (`planGenerationCreditCost`'s
 *   key, `tierPriceKey("planGeneration", tier)`).
 */
export function longAssistCredits(
  kind: ManuscriptAssistKind,
  options: { tier: ModelTier; targetWords?: number | undefined; chapterChars?: number | undefined },
  pricing: CreditPricing = creditPricing()
): number {
  switch (kind) {
    case "illustrate":
      return tierPrice(pricing, "imageGeneration", options.tier);
    case "draft_chapter": {
      const words = options.targetWords ?? DEFAULT_DRAFT_TARGET_WORDS;
      const pages = Math.min(DRAFT_MAX_BILLED_PAGES, Math.max(1, Math.ceil(words / DRAFT_WORDS_PER_PAGE)));
      return pages * tierPrice(pricing, "pageRegenerationPerPage", options.tier);
    }
    case "chapter_feedback": {
      const pages = Math.max(1, Math.ceil((options.chapterChars ?? 0) / FEEDBACK_CHARS_PER_PAGE));
      return pricing.bookTextEditBase + pages * tierPrice(pricing, "bookTextEditPerPage", options.tier);
    }
    case "consistency":
      return pricing.premiumReview;
    case "outline":
      return pricing[tierPriceKey("planGeneration", options.tier)];
  }
}

function requireText(value: string | undefined): string {
  return value?.trim() ?? "";
}

/** What the worker reads off `ManuscriptAssist.input`, per kind (see `writingAssistText.ts`, `writingAssistIllustration.ts`). */
function assistInput(kind: ManuscriptAssistKind, body: ManuscriptAssistCreateBody): Record<string, unknown> {
  switch (kind) {
    case "illustrate":
      return {
        ...(requireText(body.prompt) ? { prompt: body.prompt!.trim() } : {}),
        ...(requireText(body.passage) ? { passage: body.passage } : {})
      };
    case "draft_chapter":
      return {
        ...(requireText(body.notes) ? { notes: body.notes } : {}),
        targetWords: body.targetWords ?? DEFAULT_DRAFT_TARGET_WORDS
      };
    case "outline":
      // The premise — "what the book is about" — rides `notes`.
      return requireText(body.notes) ? { notes: body.notes } : {};
    case "chapter_feedback":
    case "consistency":
      return {};
  }
}

/**
 * Refuses what the worker could only fail (and refund) — before a credit
 * moves. Answers the chapter the assist is about, when it is about one.
 */
function validatedChapter(
  project: ManuscriptProject,
  manuscript: LoadedManuscript,
  body: ManuscriptAssistCreateBody
) {
  const live = liveChapters(manuscript.chapters);
  const kind = body.kind;
  const needsChapter = kind === "illustrate" || kind === "draft_chapter" || kind === "chapter_feedback";
  const chapter = body.chapterId ? live.find((candidate) => candidate.id === body.chapterId) : undefined;
  if (body.chapterId && !chapter) {
    throw new ManuscriptAssistRefusal(404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
  }
  if (needsChapter && !chapter) {
    throw new ManuscriptAssistRefusal(400, "CHAPTER_REQUIRED", "Choose a chapter first.");
  }
  switch (kind) {
    case "illustrate":
      if (!requireText(body.prompt) && !requireText(body.passage)) {
        throw new ManuscriptAssistRefusal(400, "PROMPT_REQUIRED", "Describe the picture you’d like first.");
      }
      break;
    case "draft_chapter":
      if (!requireText(body.notes) && !chapter!.notes.trim() && !chapter!.title.trim()) {
        throw new ManuscriptAssistRefusal(400, "NOTHING_TO_READ", "Give the chapter a title or some notes to draft from.");
      }
      break;
    case "chapter_feedback":
      if (!chapter!.markdown.trim()) {
        throw new ManuscriptAssistRefusal(400, "NOTHING_TO_READ", "This chapter has no text to read yet.");
      }
      break;
    case "consistency":
      if (!live.some((candidate) => candidate.markdown.trim())) {
        throw new ManuscriptAssistRefusal(400, "NOTHING_TO_READ", "Your book has no text to check yet.");
      }
      break;
    case "outline":
      if (manuscriptSource(project.mediaSettings) !== "written") {
        throw new ManuscriptAssistRefusal(
          409,
          "OUTLINE_NOT_AVAILABLE",
          "An outline is for a book you are starting in the Writing Studio."
        );
      }
      break;
  }
  return chapter ?? null;
}

/**
 * Creates (or replays) one long assist. Throws `ManuscriptAssistRefusal` for
 * the author's own mistakes and lets the billing errors
 * (`InsufficientCreditsError`, `GenerationQuotaExceededError`, …) through for
 * the route's shared ladder (`sendGenerationAttemptError`).
 */
export async function createLongAssist(options: {
  userId: string;
  project: ManuscriptProject;
  manuscript: LoadedManuscript;
  body: ManuscriptAssistCreateBody;
}): Promise<{ assistId: string; created: boolean }> {
  const { userId, project, manuscript, body } = options;
  const existing = await prisma.manuscriptAssist.findFirst({
    where: { projectId: project.id, requestId: body.requestId },
    select: { id: true }
  });
  if (existing) {
    return { assistId: existing.id, created: false };
  }
  const chapter = validatedChapter(project, manuscript, body);
  const kind = body.kind;
  const tier = modelTierFromMediaSettings(project.mediaSettings);
  const cost = longAssistCredits(kind, {
    tier,
    targetWords: body.targetWords,
    chapterChars: chapter?.markdown.length ?? 0
  });
  // The free-tier slot is claimed exactly as chat `add_image` claims it —
  // only when this picture is what makes the book illustrated, and only when
  // it is charged — and its "already illustrated" predicate counts an earlier
  // charged Studio illustration too (`hasChargedStudioIllustration`).
  const imageQuotaLimit = kind === "illustrate" ? await addImageQuotaLimit(userId, project.id, cost) : null;
  const input = assistInput(kind, body);
  const chapterId = chapter?.id ?? null;
  const started = await startGenerationAttempt({
    userId,
    commandKey: `mobile:studio-assist:${project.id}:${body.requestId}`,
    requestFingerprint: fingerprintGenerationRequest({ projectId: project.id, kind, chapterId, input }),
    projectId: project.id,
    operation: OPERATION[kind],
    quotedCredits: cost,
    description: DESCRIPTION[kind],
    metadata: { projectId: project.id, writingAssist: kind, ...(chapterId ? { chapterId } : {}) },
    imageQuotaLimit,
    create: async (tx, { attemptId, ledgerEntry }) => {
      const assistId = newRowId("as");
      const job = await enqueueGenerationJob({
        projectId: project.id,
        type: "WRITING_ASSIST",
        dedupeKey: `writing-assist:${assistId}`,
        payload: { assistId, attemptId },
        attemptId,
        transaction: tx,
        dispatch: false
      });
      await tx.manuscriptAssist.create({
        data: {
          id: assistId,
          projectId: project.id,
          chapterId,
          kind: ROW_KIND[kind],
          status: "QUEUED",
          input: jsonInputValue(input),
          creditsCharged: cost,
          ledgerEntryId: ledgerEntry?.id ?? null,
          generationJobId: job.id,
          requestId: body.requestId
        }
      });
      return { projectId: project.id, primaryJobId: job.id };
    }
  });
  const jobId = started.attempt.primaryJobId;
  const assist = jobId
    ? await prisma.manuscriptAssist.findFirst({ where: { projectId: project.id, generationJobId: jobId }, select: { id: true } })
    : null;
  if (!assist) {
    // Only reachable by a replayed attempt whose row went with its project.
    throw new ManuscriptAssistRefusal(409, "ASSIST_NOT_FOUND", "That request could not be found. Try again.");
  }
  if (!started.replayed && jobId) {
    await dispatchGenerationJob(jobId).catch((error: unknown) => {
      // The QUEUED row without a bullJobId is what the dispatch reconcilers
      // re-publish; the assist is late, not lost, and the charge stands.
      console.error(`Deferred dispatch of writing assist job ${jobId}`, error);
    });
  }
  return { assistId: assist.id, created: !started.replayed };
}

type AssistRow = {
  id: string;
  kind: string;
  status: string;
  chapterId: string | null;
  creditsCharged: number;
  createdAt: Date;
  error: string | null;
  result: unknown;
};

const ASSIST_SELECT = {
  id: true,
  kind: true,
  status: true,
  chapterId: true,
  creditsCharged: true,
  createdAt: true,
  error: true,
  result: true
} as const;

export async function listAssists(projectId: string, filter: { open: boolean; chapterId?: string | undefined }) {
  const rows = await prisma.manuscriptAssist.findMany({
    where: {
      projectId,
      kind: { in: AUTHOR_FACING_ASSIST_KINDS },
      ...(filter.open ? { status: { in: OPEN_STATUSES } } : {}),
      ...(filter.chapterId ? { chapterId: filter.chapterId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: ASSIST_SELECT
  });
  return rows.map(serializeAssist);
}

export async function findAssist(projectId: string, assistId: string): Promise<AssistRow | null> {
  return prisma.manuscriptAssist.findFirst({
    where: { id: assistId, projectId, kind: { in: AUTHOR_FACING_ASSIST_KINDS } },
    select: ASSIST_SELECT
  });
}

/**
 * Dismiss: the card goes away. A QUEUED one is then failed by the worker and
 * refunded (it never ran); a READY one keeps its charge (it was delivered).
 * Idempotent, and an APPLIED card stays applied.
 */
export async function dismissAssist(projectId: string, assistId: string): Promise<AssistRow | null> {
  await prisma.manuscriptAssist.updateMany({
    where: { id: assistId, projectId, status: { in: [...OPEN_STATUSES, "FAILED"] } },
    data: { status: "DISMISSED" }
  });
  return findAssist(projectId, assistId);
}

/** Applied: the author inserted the suggestion. Only a READY one can be; a repeat is idempotent. */
export async function markAssistApplied(projectId: string, assistId: string): Promise<AssistRow | null> {
  const row = await findAssist(projectId, assistId);
  if (!row) return null;
  if (row.status === "APPLIED") return row;
  if (row.status !== "READY") {
    throw new ManuscriptAssistRefusal(409, "ASSIST_NOT_READY", "That suggestion isn’t ready to use.");
  }
  await prisma.manuscriptAssist.updateMany({
    where: { id: assistId, projectId, status: "READY" },
    data: { status: "APPLIED" }
  });
  return findAssist(projectId, assistId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The result, field by field. The row may carry more than the author may see —
 * an illustration keeps a provenance record naming providers — so nothing is
 * spread: only these keys leave, and none of them contains "model".
 */
function serializeResult(kind: ManuscriptAssistKind, raw: unknown): ManuscriptAssistResultDto {
  if (raw === null || raw === undefined) return null;
  const result = jsonRecord(raw);
  switch (result.type) {
    case "image":
      return kind === "illustrate" && text(result.url) ? { type: "image", url: text(result.url), alt: text(result.alt) } : null;
    case "draft":
      return { type: "draft", markdown: text(result.markdown) };
    case "notes": {
      const notes = Array.isArray(result.notes) ? result.notes : [];
      return {
        type: "notes",
        notes: notes.map((entry): ManuscriptAssistNoteDto => {
          const note = jsonRecord(entry);
          return {
            quote: typeof note.quote === "string" ? note.quote : null,
            note: text(note.note),
            severity: note.severity === "issue" ? "issue" : "suggestion",
            ...(kind === "consistency" ? { chapterId: typeof note.chapterId === "string" ? note.chapterId : null } : {})
          };
        })
      };
    }
    case "outline": {
      const chapters = Array.isArray(result.chapters) ? result.chapters : [];
      return {
        type: "outline",
        chapters: chapters.map((entry) => {
          const chapter = jsonRecord(entry);
          return { title: text(chapter.title), notes: text(chapter.notes) };
        })
      };
    }
    default:
      return null;
  }
}

export function serializeAssist(row: AssistRow): ManuscriptAssistDto {
  const kind = WIRE_KIND[row.kind] ?? "illustrate";
  return {
    id: row.id,
    kind,
    status: row.status.toLowerCase() as ManuscriptAssistStatus,
    chapterId: row.chapterId,
    creditsCharged: row.creditsCharged,
    createdAt: row.createdAt.toISOString(),
    error: row.status === "FAILED" ? (row.error ?? "That request couldn’t be finished.") : null,
    result: serializeResult(kind, row.result)
  };
}
