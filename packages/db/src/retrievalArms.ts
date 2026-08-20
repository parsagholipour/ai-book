/**
 * The failure policy every multi-arm retrieval in this package shares with the
 * worker's `loadContinuityNotes`: one arm going down degrades to what the others
 * returned, instead of settling the call around it. It sits apart from the
 * retrievals because it is about failures rather than embeddings — the worker
 * reaches for it over continuity notes, which are not embeddings at all.
 */

/**
 * How many times each arm failure has been seen this process, keyed by arm
 * *and* message so a new failure mode earns its own line instead of hiding
 * behind an earlier arm's warning. Counted rather than merely remembered
 * because the count is the whole input to
 * {@link shouldReportArmFailureOccurrence}.
 */
const retrievalArmFailureCounts = new Map<string, number>();

/**
 * A memory bound, and nothing else. A message carrying a unique detail — a row
 * id, a statement timeout naming its own duration — is a new key every time,
 * and this census must not grow for the life of a worker. Overflow drops the
 * counts, so a fault still occurring simply starts its ladder again: forgetting
 * a count can only make reporting louder, never quieter, which is what lets the
 * bound be this blunt.
 *
 * It is deliberately not the re-notification policy. That is
 * {@link shouldReportArmFailureOccurrence}, which behaves identically whether
 * or not this limit is ever reached — and in the case it matters most for, a
 * single chronic message repeating on every page, it never is.
 */
const REPORTED_ARM_FAILURE_LIMIT = 64;

/**
 * The re-notification policy: report the 1st occurrence, then the 10th, 100th,
 * 1000th — every power of ten.
 *
 * Reporting only the first occurrence is right for a permanent fault and wrong
 * for an intermittent one, and nothing at the call site can tell the two apart:
 * a database missing `pg_trgm` and a recurring connection reset both arrive as
 * one stable message. A ladder answers both without having to. A permanent
 * environment fact costs about one line per order of magnitude rather than one
 * line per page job, so the first line is still not buried; a recurring
 * transient fault keeps climbing instead of falling silent after the first page
 * job that met it.
 *
 * Each rung carries the running count and the project it happened to hit, which
 * is the cheap version of the question worth asking — the same message on a
 * project that is not the one in the first line is a fault spreading across
 * books, while the same message on the same book is an environment fact
 * standing still. That costs no memory beyond the count itself, so no set of
 * seen project ids is kept.
 *
 * A count rather than a clock: no `Date.now()` reaches this decision, so the
 * same sequence of failures reports identically in a test, on a loaded worker
 * and on an idle one.
 */
function shouldReportArmFailureOccurrence(occurrence: number): boolean {
  let rung = 1;
  while (rung < occurrence) {
    rung *= 10;
  }
  return rung === occurrence;
}

export type DegradeRetrievalArmOptions<TFallback> = {
  /** Name of the arm; logged verbatim as `<arm> failed for project <id>`. */
  arm: string;
  projectId: string;
  error: unknown;
  /** What the arm contributes when it cannot answer — in practice `[]`. */
  fallback: TFallback;
  /**
   * Errors this arm must not swallow — the worker passes its stop-signal
   * predicate, `isStopRequestedError` — or `null` for a call site with no
   * cancellation to honour (this package's own suites).
   *
   * Required rather than optional, for the reason
   * {@link RetrieveHybridEmbeddingsOptions.rethrowIf} is: a stopped generation
   * has to reach the job runner as a stop, never as a quietly thinner result,
   * and a degrade *looks* like success — so an omission costs nothing at the
   * moment it is made and everything later. An optional predicate is silently
   * absent at the next call site; a required one is a compile error there, and
   * the compiler is the only reviewer every future caller passes. `null` is a
   * claim, not an opt-out.
   */
  rethrowIf: ((error: unknown) => boolean) | null;
};

/**
 * Degrades one arm of a multi-arm retrieval to `fallback` instead of failing
 * the retrieval around it. The policy is shared rather than hand-rolled per
 * site because the hazard is shared: a database where migration
 * `000055_trigram_memory_search` could not `CREATE EXTENSION pg_trgm` — no
 * superuser on a managed Postgres, or a stack migrated before that branch —
 * answers every `strict_word_similarity` call with `function ... does not
 * exist`, on every page of every book. Under a plain `Promise.all` that one
 * rejection settles the whole retrieval, which is how {@link
 * retrieveHybridEmbeddings} lost its *vector* rows to a lexical fault and left
 * long books with no long-range continuity at all — strictly worse than before
 * the lexical arm existed. The worker's `loadContinuityNotes` had already
 * learned this and wrapped only its optional promise; the second site had to
 * learn it again, so the third one gets it from here.
 *
 * Failures are counted per (arm, message) per process and reported on the
 * ladder {@link shouldReportArmFailureOccurrence} owns: the first occurrence,
 * then every power of ten. A message not seen before always prints, so an SQL
 * error introduced by a change stays visible instead of hiding behind an
 * earlier arm's warning.
 *
 * What it never degrades is whatever `rethrowIf` claims — a required option,
 * not an optional one, and the option is where that is argued.
 */
export function degradeRetrievalArm<TFallback>(options: DegradeRetrievalArmOptions<TFallback>): TFallback {
  if (options.rethrowIf?.(options.error)) {
    throw options.error;
  }
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  const key = `${options.arm}\u0000${message}`;
  if (!retrievalArmFailureCounts.has(key) && retrievalArmFailureCounts.size >= REPORTED_ARM_FAILURE_LIMIT) {
    retrievalArmFailureCounts.clear();
  }
  const occurrence = (retrievalArmFailureCounts.get(key) ?? 0) + 1;
  retrievalArmFailureCounts.set(key, occurrence);
  if (shouldReportArmFailureOccurrence(occurrence)) {
    console.warn(
      occurrence === 1
        ? `${options.arm} failed for project ${options.projectId}`
        : `${options.arm} failed for project ${options.projectId} (seen ${occurrence} times this process)`,
      options.error
    );
  }
  return options.fallback;
}
