import { modelTierFromMediaSettings, type ModelTier } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { ProjectStatusResult } from "./dto.js";
import { BOOK_PROGRESS_START } from "./generationProgress.js";
import { imageSettingsFromMediaSettings } from "./imageSettings.js";
import { planningJobFor } from "./planningProgress.js";

/**
 * "About 4 min left" while a plan or a book is being made: the
 * `estimatedSecondsLeft` on the status payload's `planningProgress` and
 * `generationProgress`.
 *
 * Seconds left rather than a finishing time, because the phone's clock may be
 * wrong and the app counts down on its own between statuses. The number is two
 * readings blended:
 *
 * - **the schedule** — how long a run like this one usually takes (`typical`),
 *   less the time this one has already run;
 * - **the pace** — once a fifth of the bar is behind it, the time so far
 *   stretched over what is left of the bar.
 *
 * It is never below `MIN_SECONDS_LEFT` while the work still runs and never above
 * three typical runs, and it is rounded up — to 30 s under ten minutes, to the
 * minute above — so it changes about twice a minute at most: the status stream
 * sends a status only when its JSON changed, and a number that moved every read
 * would send one every three seconds. It is null whenever a number would be a
 * guess: the book is waiting in line or its work has not started, the run is a
 * paid retry that began part-way, the run has overrun its schedule before a
 * fifth of the bar, or there is nothing running at all.
 *
 * `typical` is measured, not assumed. The last 30 days of finished first runs
 * of the same operation are read once per ten minutes per process (one query,
 * single-flight; a failed read uses the compiled model alone and is asked again
 * a minute later, never failing the status). Each run is compared against the
 * compiled model for its own tier, pictures and length (`modelSeconds`), and the
 * median of those ratios over the narrowest pool holding five runs — same tier,
 * pictures and length bucket, then without the length bucket, without the
 * pictures, without the tier — scales this book's model. Pooling ratios rather
 * than raw durations is what keeps a widened pool honest: a 60-page book does
 * not inherit the median of the 10-page books it was pooled with.
 */

export type EstimatedOperation = "PLAN_GENERATION" | "PLAN_REVISION" | "FULL_BOOK_GENERATION";

/** What a run's length depends on, as far as this estimate looks. */
export type EstimatedBook = { tier: ModelTier; illustrated: boolean; pages: number };

/** One finished first run: what it was, and how long it took from start to finish. */
export type DurationSample = EstimatedBook & { operation: EstimatedOperation; seconds: number };

export type DurationHistory = ReadonlyArray<DurationSample>;

/** What the status serializer needs beside the status itself; read by `loadEstimateInputs`. */
export type EstimateInputs = {
  now: number;
  history: DurationHistory;
  /** When the open full-book run started, or null when there is none to time. */
  bookRunStartedAt: Date | null;
};

export type StatusSecondsLeft = { planning: number | null; generation: number | null };

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000;
const HISTORY_TTL_MS = 10 * 60_000;
const FAILED_HISTORY_TTL_MS = 60_000;
/** The newest runs only: a bound on memory, far above what a median needs. */
const HISTORY_ROW_CAP = 3_000;
const MIN_SAMPLES = 5;
/** The pace reading joins in once this much of the bar is behind the run. */
const PACE_FROM_FRACTION = 0.2;
const MIN_SECONDS_LEFT = 20;
const MAX_TYPICAL_MULTIPLE = 3;

const OPERATIONS: ReadonlySet<string> = new Set<EstimatedOperation>([
  "PLAN_GENERATION",
  "PLAN_REVISION",
  "FULL_BOOK_GENERATION"
]);

/**
 * The compiled model, measured on dev on 2026-10-17: a plan in 16–40 s, a
 * 10-page illustrated picture book in ~70 s on Quick Draft and ~100 s on
 * Balanced, a 30-page novel in 4–5 min, a 60-page nonfiction book in 8–11 min.
 * A picture book's page is a few lines, so the first twelve pages cost less
 * than the rest. It is what an estimate says with no history, and what history
 * is measured against when there is some.
 */
const PLAN_SECONDS: Record<ModelTier, number> = { fast: 18, balanced: 40, premium: 55, ultra: 75 };
const BOOK_TIER_PACE: Record<ModelTier, number> = { fast: 1, balanced: 1.3, premium: 1.7, ultra: 2.2 };

export function modelSeconds(operation: EstimatedOperation, book: EstimatedBook): number {
  const pages = Number.isFinite(book.pages) ? Math.max(1, Math.round(book.pages)) : 12;
  if (operation === "FULL_BOOK_GENERATION") {
    const writing = 20 + 4 * Math.min(pages, 12) + 9 * Math.max(0, pages - 12);
    return (BOOK_TIER_PACE[book.tier] ?? BOOK_TIER_PACE.balanced) * writing * (book.illustrated ? 1.2 : 1);
  }
  const plan = (PLAN_SECONDS[book.tier] ?? PLAN_SECONDS.balanced) * (1 + Math.min(pages, 200) / 200);
  return operation === "PLAN_REVISION" ? plan * 0.7 : plan;
}

/** ≤12, 13–40, 41–80, 81+ pages. */
export function pageBucket(pages: number): number {
  const bucket = [12, 40, 80].findIndex((ceiling) => pages <= ceiling);
  return bucket < 0 ? 3 : bucket;
}

/** Narrowest first: each pool drops one more thing the book has in common with the runs in it. */
const POOLS: ReadonlyArray<(sample: DurationSample, book: EstimatedBook) => boolean> = [
  (sample, book) =>
    sample.tier === book.tier && sample.illustrated === book.illustrated && pageBucket(sample.pages) === pageBucket(book.pages),
  (sample, book) => sample.tier === book.tier && sample.illustrated === book.illustrated,
  (sample, book) => sample.tier === book.tier,
  () => true
];

/** How long a run like this one usually takes, in seconds. */
export function typicalSeconds(operation: EstimatedOperation, book: EstimatedBook, history: DurationHistory): number {
  const model = modelSeconds(operation, book);
  const runs = history.filter((sample) => sample.operation === operation);
  for (const inPool of POOLS) {
    const ratios = runs
      .filter((sample) => inPool(sample, book))
      .map((sample) => sample.seconds / modelSeconds(operation, sample));
    if (ratios.length >= MIN_SAMPLES) {
      return model * median(ratios);
    }
  }
  return model;
}

/**
 * Seconds left for a run `fraction` of the way along its bar after
 * `elapsedSeconds`, against a typical run of `typicalSeconds`; null when no
 * reading stands behind a number.
 */
export function secondsLeft(input: { typicalSeconds: number; elapsedSeconds: number; fraction: number }): number | null {
  const typical = input.typicalSeconds;
  if (!(typical > 0) || !Number.isFinite(input.elapsedSeconds) || !Number.isFinite(input.fraction)) {
    return null;
  }
  const elapsed = Math.max(0, input.elapsedSeconds);
  const done = Math.max(0, Math.min(1, input.fraction));
  const schedule = typical - elapsed;
  const pace = done >= PACE_FROM_FRACTION ? (elapsed * (1 - done)) / done : null;
  // Past its schedule with under a fifth of the bar behind it, a run has told
  // us only that it is slow — any number would be invented.
  const blended = pace === null ? (schedule > 0 ? schedule : null) : schedule > 0 ? (schedule + pace) / 2 : pace;
  if (blended === null) {
    return null;
  }
  return roundSecondsLeft(Math.min(MAX_TYPICAL_MULTIPLE * typical, Math.max(MIN_SECONDS_LEFT, blended)));
}

/** Up to the next 30 s under ten minutes, the next minute above. */
export function roundSecondsLeft(seconds: number): number {
  const step = seconds < 600 ? 30 : 60;
  return Math.ceil(seconds / step) * step;
}

/**
 * The estimates for this status, from the percents its progress objects
 * already carry. The book's own bar starts at `BOOK_PROGRESS_START`, so a run's
 * fraction is measured from there, not from zero.
 */
export function statusSecondsLeft(
  status: ProjectStatusResult,
  percents: StatusSecondsLeft,
  inputs: EstimateInputs | null
): StatusSecondsLeft {
  const none = { planning: null, generation: null };
  const project = status.project;
  if (!inputs || status.waitingInLine) {
    return none;
  }
  const book = estimatedBook(project);
  if (project.status === "PLANNING" && percents.planning !== null) {
    const job = planningJobFor(status);
    // Queued is not started: a plan waiting for the worker has no clock yet.
    if (job?.status !== "ACTIVE" || !job.startedAt) {
      return none;
    }
    const operation = job.type === "REVISE_PLAN" ? "PLAN_REVISION" : "PLAN_GENERATION";
    return {
      planning: secondsLeft({
        typicalSeconds: typicalSeconds(operation, book, inputs.history),
        elapsedSeconds: (inputs.now - job.startedAt.getTime()) / 1000,
        fraction: percents.planning / 100
      }),
      generation: null
    };
  }
  if (project.status === "GENERATING" && percents.generation !== null && inputs.bookRunStartedAt) {
    return {
      planning: null,
      generation: secondsLeft({
        typicalSeconds: typicalSeconds("FULL_BOOK_GENERATION", book, inputs.history),
        elapsedSeconds: (inputs.now - inputs.bookRunStartedAt.getTime()) / 1000,
        fraction: (percents.generation - BOOK_PROGRESS_START) / (100 - BOOK_PROGRESS_START)
      })
    };
  }
  return none;
}

/**
 * Everything `statusSecondsLeft` reads beyond the status, or null for a status
 * no estimate is made for — so a settled or waiting book costs no read at all.
 */
export async function loadEstimateInputs(status: ProjectStatusResult, now = Date.now()): Promise<EstimateInputs | null> {
  const project = status.project;
  if ((project.status !== "PLANNING" && project.status !== "GENERATING") || status.waitingInLine) {
    return null;
  }
  const [history, bookRunStartedAt] = await Promise.all([
    durationHistory(now),
    project.status === "GENERATING" ? openBookRunStart(project.id) : Promise.resolve(null)
  ]);
  return { now, history, bookRunStartedAt };
}

function estimatedBook(project: ProjectStatusResult["project"]): EstimatedBook {
  return {
    tier: modelTierFromMediaSettings(project.mediaSettings),
    illustrated: imageSettingsFromMediaSettings(project.mediaSettings).illustrationsEnabled,
    pages: project.targetPages
  };
}

/**
 * The open full-book run's start. The attempt rather than the book job: the
 * attempt is stamped once, when its first job is claimed, and stays open until
 * the compile publishes, while the job's own `startedAt` moves on every
 * reclaim and the job can fall out of the status read's 25-row window. A paid
 * retry is not timed — it resumes the failed part of a run, so its clock
 * started late against a bar that did not start at the bottom.
 */
async function openBookRunStart(projectId: string): Promise<Date | null> {
  try {
    const attempt = await prisma.generationAttempt.findFirst({
      where: { projectId, operation: "FULL_BOOK_GENERATION", status: { in: ["QUEUED", "ACTIVE"] } },
      orderBy: { createdAt: "desc" },
      select: { status: true, startedAt: true, retryOfAttemptId: true }
    });
    return attempt?.status === "ACTIVE" && !attempt.retryOfAttemptId ? (attempt.startedAt ?? null) : null;
  } catch (error) {
    console.error("Could not read a book run's start for its time-left estimate", error);
    return null;
  }
}

let cachedHistory: { at: number; ttlMs: number; samples: Promise<DurationHistory> } | null = null;

function durationHistory(now: number): Promise<DurationHistory> {
  if (cachedHistory && now - cachedHistory.at < cachedHistory.ttlMs) {
    return cachedHistory.samples;
  }
  const entry = { at: now, ttlMs: HISTORY_TTL_MS, samples: Promise.resolve<DurationHistory>([]) };
  entry.samples = readDurationHistory(new Date(now - HISTORY_WINDOW_MS)).catch((error: unknown) => {
    // The compiled model stands in, and the read is asked again a minute later
    // rather than on every status poll.
    console.error("Could not read generation durations for a time-left estimate", error);
    entry.ttlMs = FAILED_HISTORY_TTL_MS;
    return [];
  });
  cachedHistory = entry;
  return entry.samples;
}

type HistoryRow = { operation: string; tier: string; illustrated: boolean; pages: number; seconds: number };

/**
 * Finished first runs since `since`. Tier and pictures are read the way
 * `modelTierFromMediaSettings` and `imageSettingsFromMediaSettings` read them
 * (no tier is balanced; pictures are on unless switched off), and the
 * `(status, refundPending, updatedAt)` index serves the window, since a
 * succeeded attempt is last written when it finishes.
 */
async function readDurationHistory(since: Date): Promise<DurationHistory> {
  const rows = await prisma.$queryRaw<HistoryRow[]>`
    SELECT a."operation"::text AS "operation",
      CASE WHEN p."mediaSettings"->>'modelTier' IN ('fast', 'premium', 'ultra')
        THEN p."mediaSettings"->>'modelTier' ELSE 'balanced' END AS "tier",
      (p."mediaSettings"->'fullIllustrations') IS DISTINCT FROM 'false'::jsonb AS "illustrated",
      p."targetPages" AS "pages",
      EXTRACT(EPOCH FROM (a."finishedAt" - a."startedAt"))::float8 AS "seconds"
    FROM "GenerationAttempt" a
    JOIN "Project" p ON p."id" = a."projectId"
    WHERE a."status" = 'SUCCEEDED'
      AND a."refundPending" = false
      AND a."updatedAt" >= ${since}
      AND a."operation" IN ('PLAN_GENERATION', 'PLAN_REVISION', 'FULL_BOOK_GENERATION')
      AND a."retryOfAttemptId" IS NULL
      AND a."startedAt" IS NOT NULL
      AND a."finishedAt" >= a."startedAt"
    ORDER BY a."updatedAt" DESC
    LIMIT ${HISTORY_ROW_CAP}
  `;
  return (rows ?? []).flatMap((row) => {
    const seconds = Number(row.seconds);
    const pages = Number(row.pages);
    if (!OPERATIONS.has(row.operation) || !(row.tier in BOOK_TIER_PACE) || !(seconds > 0) || !(pages > 0)) {
      return [];
    }
    return [{
      operation: row.operation as EstimatedOperation,
      tier: row.tier as ModelTier,
      illustrated: row.illustrated === true,
      pages,
      seconds
    }];
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function resetDurationHistoryForTests(): void {
  cachedHistory = null;
}
