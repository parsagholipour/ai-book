---
name: add-job-type
description: Use when adding, renaming, or removing a BullMQ job type — a new `enum JobType` value in schema.prisma, a new file under apps/worker/src/handlers/, a new `case` in the `switch (job.name)` in apps/worker/src/processJob.ts, or a change to `jobNames` in packages/core/src/jobDispatch.ts. One job type is mirrored across eleven lists that mostly do not typecheck against each other: `DERIVATIVE_GENERATION_JOBS`, `jobOwnsQualityVerdict`, `NETWORK_RETRYABLE_JOB_NAMES`, `canRecoverGenerationJob`, and the JobType→CreditOperation `CASE` in the admin SQL — plus the three that the compiler now does check, `JOB_STEP_TEMPLATES`, `JOB_PAGE_REWRITE_SCOPE` and `WORKER_FANOUT_JOB_TYPES`. Reach for this on "add a job", "the worker throws Unknown worker job", "the progress bar is empty for my new job", "why didn't my job get retried", or "my job marked the book FAILED".
---

# Adding, renaming, or removing a job type

A job type is one name spread across the Prisma enum, the worker's dispatch switch, several
policy sets in `packages/core`, and a handful of API display mirrors. The compiler catches about
half of it now — the tables typed against `GenerationJobType` — and none of the `Set`s, the
hand-written unions or the SQL. This is the ordered footprint and the part that fails silently.

Reasoning for the queue design lives in [`apps/worker/CLAUDE.md`](../../../apps/worker/CLAUDE.md);
the failure/settlement rules that decide half the questions below live in
[`apps/worker/src/handlers/CLAUDE.md`](../../../apps/worker/src/handlers/CLAUDE.md) and
[`apps/api/CLAUDE.md`](../../../apps/api/CLAUDE.md). Read those before deciding, not after.

## Before checking whether the mirrors below still exist

Three of these duplications were collapsed in a parallel change, and they landed at different
times:

- `enqueueWorkerJob`'s hand-written literal unions in `apps/worker/src/runtime/dispatch.ts` —
  **already repaired.** It now takes `type: WorkerFanoutJobType`, derived from
  `WORKER_FANOUT_JOB_TYPES` (`as const satisfies readonly GenerationJobType[]`), and there is no
  `name` parameter at all: the BullMQ name comes from `workerJobNameForType` at dispatch time. The
  list is deliberately *narrower* than `GenerationJobType` — planning, edits, replans and imports
  are started by the API, which owns their charge.
- The three copied lists (`apps/api/src/projectStatus.ts`, `apps/api/src/routes/projects.ts`,
  `apps/api/src/mobile/schemas.ts`) are gone: all three now import the leaf module
  `apps/api/src/generationJobTypes.ts`. `mobile/schemas.ts` re-exports them under the old names.
- `JOB_STEP_TEMPLATES` now lives in `packages/core/src/jobSteps.ts` as an exhaustive
  `Record<GenerationJobType, readonly JobStepTemplate[]>`, and the console's copy of it is **gone
  too**: `packages/core/package.json` exports `./jobSteps` as a narrow subpath and
  `apps/web/src/jobsDisplay.ts` derives its fallback labels from that record. All three of these
  have now landed, so this section is history rather than a warning — but keep grepping.

This skill is written against the repaired shape. **Grep for each symbol before editing it** — if
it no longer exists where this says, the repair landed and the single derived definition is the
only site. A mirror that is gone is good news; a mirror that is still there is still load-bearing.

## Step 1 — four decisions, because they select which lists you join

**1. Which casing is this job in each file?**
The Prisma `JobType` value is SCREAMING_SNAKE (`GENERATE_AUDIOBOOK`); the BullMQ job name is
kebab (`generate-audiobook`). `jobNames` in `packages/core/src/jobDispatch.ts` is the canonical
map between them — `GenerationJobType` and `WorkerJobName` are both derived from it, and
`workerJobNameForType` is the only sanctioned translation. Everything downstream keys off one or
the other and nothing warns you when you pick wrong:

| Site | Keyed by |
| --- | --- |
| `processJob.ts` `switch (job.name)` | kebab |
| `packages/core/src/jobSteps.ts` `JOB_STEP_TEMPLATES` | SCREAMING (`runtime/jobProgress.ts` translates) |
| `jobDispatch.ts` `NETWORK_RETRYABLE_JOB_NAMES`, `retryJobOptions` | kebab |
| `jobScope.ts` `DERIVATIVE_GENERATION_JOBS` | both (keys SCREAMING, values kebab) |
| `jobScope.ts` `JOB_PAGE_REWRITE_SCOPE`, `PAGE_REWRITING_JOB_TYPES` | SCREAMING |
| `mobile/schemas.ts` job-type lists, `generationRecovery.ts` | SCREAMING |
| `admin/operationEconomics.ts` SQL `CASE j.type::text` | SCREAMING |

The Prisma enum has one value `jobNames` deliberately omits — `RESEARCH`. Nothing writes it and
the worker rejects it, so it is not a precedent for leaving a new type out.

**2. Is it derivative?** A job that produces an optional experience *from* an already-finished,
already-paid book (an audiobook, a character portrait, character candidates) must never move
`Project.status` and must never refund the book's charge. If so it belongs in
`DERIVATIVE_GENERATION_JOBS` in `packages/core/src/jobScope.ts`. The allowlist is deliberately
narrow and an unlisted job defaults to owning the book's lifecycle — which is the safe default
only if you actually want failure to fail the book.

**3. Is it network-retryable?** Only jobs that can *resume* from settled work belong in
`NETWORK_RETRYABLE_JOB_NAMES` (module-private in `jobDispatch.ts`, read by
`shouldRecoverJobAttempt` and `shouldBypassConfiguredRetries`). Adding a name there without an
attempt budget in `retryJobOptions` does nothing; adding a budget without resume semantics
re-does paid work. Each retryable job has its own `*_RECOVERY_ATTEMPTS` const beside the set.

**4. Does it own the project's outcome and its quality verdict?** Two different questions:
- *Lifecycle*: `generationJobOwnsFailureLifecycle(type, payload)` — derivative jobs and the two
  payload-flagged kinds (`DETACHED_FROM_PROJECT_LIFECYCLE`, `PRESENTATION_ONLY_RECOMPILE`) settle
  alone.
- *Verdict*: `jobOwnsQualityVerdict(type, payload)` — today only `COMPILE_EXPORT` writes a
  manuscript quality report at all. It is evaluated where rows are born and stored on the
  `GenerationJob.ownsQualityVerdict` column, so a new job that writes a `qualityReport` needs
  both the predicate *and* a migration/backfill decision.

A fifth thing to notice rather than decide: `GenerationJob.projectId` is nullable, and
`GENERATE_CHARACTER_PORTRAIT` is the one job that uses it. If your job is account-scoped rather
than project-scoped, every project-scoped query (stop, settlement, status, `failureMessage`) will
simply never see the row, and you must arrange its own failure settlement — see
`failCharacterPortraitForJob` in `apps/worker/src/runtime/jobLifecycle.ts`.

## Step 2 — edit sites, in dependency order

1. `packages/db/prisma/schema.prisma` — add to `enum JobType`. Then `pnpm db:generate`
   (`packages/db/src/generated/` is gitignored; never hand-edit it). Removing a value needs a
   migration that also handles existing rows.
2. `packages/core/src/jobDispatch.ts` — `jobNames`. This is the canonical entry; the
   `GenerationJobType`/`WorkerJobName` types follow from it. Then, only if decision 3 said yes:
   `NETWORK_RETRYABLE_JOB_NAMES`, a `*_RECOVERY_ATTEMPTS` const, and a branch in
   `retryJobOptions`.
3. `packages/core/src/jobScope.ts` — `DERIVATIVE_GENERATION_JOBS` if decision 2 said yes;
   `jobOwnsQualityVerdict` if decision 4 said the job reports a verdict; and
   `JOB_PAGE_REWRITE_SCOPE`, which is exhaustive and so will not compile until you answer it.
   Answer it for a *queued or running row* of this type, not for the handler's happiest path —
   `never` is a claim that nothing this row does can change what a page says or whether it passed
   QA, and a status poll counts pages on that answer (`PAGE_REWRITING_JOB_TYPES` is derived from
   it, so there is no second list to update).
4. `apps/worker/src/handlers/<name>.ts` — the handler, exporting
   `export async function myJob(job: Job)`. Handlers may import from `generation/`, `providers/`
   and `runtime/`; they must not import `runtime/queue.ts` (importing it opens Redis). Provider
   calls go through the logged-adapter wrapper, not raw adapters — see
   [`apps/worker/src/handlers/CLAUDE.md`](../../../apps/worker/src/handlers/CLAUDE.md).
5. `apps/worker/src/processJob.ts` — a `case` in `switch (job.name)`. The `default` throws
   `Unknown worker job: <name>`; that error string is the symptom of skipping this step.
   Return a `JobCompletion` only if you need `afterJobCompleted` or
   `durableCompletionCommitted`.
6. `packages/core/src/jobSteps.ts` — `JOB_STEP_TEMPLATES`, **keyed by `GenerationJobType`**
   (SCREAMING). The app and the console render these labels, and the console derives its fallback
   labels straight from this record through the `./jobSteps` subpath export, so `apps/web` needs no
   edit of its own. The record is exhaustive, so a missing entry is a compile error.
   `apps/worker/src/runtime/jobProgress.ts` needs no edit either: its `buildStepTemplate` translates
   the kebab job name through `generationJobTypeForWorkerName` and still returns `[]` for an
   unknown name.
7. `apps/worker/src/runtime/dispatch.ts` — `WORKER_FANOUT_JOB_TYPES`, but **only if the worker
   itself fans out to this job**. A job the API starts must stay out of that list; the narrowing is
   the point. Never call `queue.add` directly: the durable row is written first and
   `reconcileUndispatchedWorkerJobs` re-pushes anything that never reached Redis.
8. `apps/api/src/mobile/schemas.ts` — `retryablePlanningJobTypes`, `resumableJobTypes`,
   `restartableJobTypes`; `generationFailureJobTypes` is their concatenation and needs no edit.
   Check `apps/api/src/projectStatus.ts` and `apps/api/src/routes/projects.ts` for surviving
   copies of the same four lists.
9. `apps/api/src/mobile/generationRecovery.ts` — `canRecoverGenerationJob`. Its trailing
   `return type === "COMPILE_EXPORT" || …` means an unlisted type is **not** recoverable; that is
   the safe default, but `retryAvailable` in the status read and the `/resume` write have to give
   the same answer, so change it here (one definition) and nowhere else.
10. `apps/api/src/mobile/generationProgress.ts` — if the job should move the book's
    plan/write/illustrate/finish steps. `apps/api/src/mobile/editProgress.ts` — only if it is an
    edit-class job; its `EditJobType` is a hand-written union of `APPLY_BOOK_EDIT`,
    `CONTINUE_BOOK`, `REPLAN_BOOK` with exhaustive `STEP_LABELS`/`STEP_ORDER` records.
11. `apps/api/src/admin/operationEconomics.ts` — the `CASE j.type::text` mapping JobType to
    `CreditOperation`. An unmapped type falls through to the unbilled buckets rather than being
    attributed by guess, so omitting it understates nothing but leaves the job's provider spend
    permanently in "unbilled".
12. Also check, if the job can be stopped or can fail a book: `BOOK_RUN_JOB_TYPES` in
    `apps/api/src/queue.ts` (the API's own settlement path), and
    `failureMessageForJob` in `apps/api/src/mobile/projectSerializers.ts`.

## Step 3 — what the compiler catches vs what fails silently

**The compiler catches:**
- `failureMessageForJob`'s phrase table — `satisfies Record<GenerationJobType, string>`.
- `editProgress.ts`'s `STEP_LABELS` / `STEP_ORDER` — `Record<EditJobType, …>`.
- Anything typed `GenerationJobType` that you spell wrong.
- `WORKER_FANOUT_JOB_TYPES` — its `satisfies readonly GenerationJobType[]` fails on a renamed or
  removed `jobNames` entry rather than silently enqueueing a job the dispatch switch cannot name.
  (This is also why `{ type: "GENERATE_BOOK", name: "generate-page" }` is no longer expressible.)
- `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts` — `Record<GenerationJobType, …>`, and
  since `apps/web/src/jobsDisplay.ts` derives the console's fallback labels from it, the one entry
  the compiler demands is the only entry there is. This used to be the loudest silent mirror on the
  list below.
- `JOB_PAGE_REWRITE_SCOPE` in `packages/core/src/jobScope.ts` — `Record<GenerationJobType,
  PageRewriteScope>`, so a new type must say whether an open row of it can still rewrite a page
  before anything compiles.

**Nothing catches (all of these are `Record<string, …>`, a `Set<string>`, or SQL):**
- A missing `case` in `processJob.ts` — runtime `Unknown worker job: <name>`, the job fails and
  (unless derivative) fails the book.
- A missing `NETWORK_RETRYABLE_JOB_NAMES` entry — no retry, ever, silently.
- A missing `DERIVATIVE_GENERATION_JOBS` entry — the job's failure flips the project FAILED and
  refunds the book's `GENERATE_BOOK` charge. Loudest wrong outcome on this list.
- A missing SQL `CASE` arm — spend shows up as unbilled in the Operations tab.
- The kebab/SCREAMING mix-up in either direction — the entry exists and is never read.

## Step 4 — verify

```bash
pnpm db:generate                     # after any schema.prisma change
pnpm typecheck                       # catches the Record/satisfies mirrors
pnpm --filter @book-maker/core test  # jobDispatch.test.ts, jobScope.test.ts
pnpm --filter @book-maker/worker test # dispatch.test.ts, processJob.test.ts
pnpm check                           # typecheck + lint + file-size budget + all tests
```

Then run it for real once — `MOCK_AI=true pnpm dev:api` and `MOCK_AI=true pnpm dev:worker` — and
confirm three things no test asserts: the job appears with named steps in the app/console progress
UI, its run log lands under `<BOOK_STORAGE_DIR>/<projectId>/runs/<run>-<job-name>.jsonl`, and a
deliberately failed run settles the way decision 2/4 said it should (check `Project.status` and
the `CreditLedgerEntry` rows, not just the job row).
