---
name: diagnose-book-generation
description: Read-before-edit triage for a book run, export or narration that is stuck, failed, duplicated or wrongly charged — "stuck on Preparing PDF forever", "the project is stuck in EDITING", "the quality report disappeared", "a COMPLETE book shows as needing attention", "deleting the book refunded the purchase", "the PDF is stale after an edit", "the audiobook failure failed the whole book", "charged twice", "the job ran twice". Step 0 is always `ps -eo pid,args | grep dev:worker`, because a stray host worker racing the Docker stack explains most impossible-looking symptoms; then the run logs under `<BOOK_STORAGE_DIR>/<projectId>/runs/`, then the `GenerationJob` row's `dedupeKey`, payload flags (`detachedFromProjectLifecycle`, `presentationOnlyRecompile`, `skipFinalReview`) and `ownsQualityVerdict` column. Use it before proposing any fix to generation, export publication, settlement or refunds.
---

# Diagnosing a book run, export or narration

Establish *which code ran* before proposing a fix. Almost every confusing symptom here comes from
one of three things: a second worker you did not know about, a job whose payload flags put it on a
different settlement path than you assumed, or two parallel implementations of the same rule
disagreeing.

Background for each subsystem: [`apps/worker/CLAUDE.md`](../../../apps/worker/CLAUDE.md),
[`apps/worker/src/generation/CLAUDE.md`](../../../apps/worker/src/generation/CLAUDE.md),
[`apps/api/src/mobile/CLAUDE.md`](../../../apps/api/src/mobile/CLAUDE.md),
[`packages/db/CLAUDE.md`](../../../packages/db/CLAUDE.md).

## Step 0 — is there more than one worker?

```bash
ps -eo pid,args | grep -E 'dev:worker|dev:api|tsx-dev'
docker compose ps
```

`make up` and `pnpm dev` are **the same queue**. A host worker defaults to
`redis://localhost:6379` and `./storage` — the Docker stack's published port and bind mount — so
running both means two workers racing for one book's jobs, and a `MOCK_AI=true` host worker will
happily answer a real generation with canned text. Symptoms this explains: a job that "ran twice",
pages written in placeholder prose, work completing with no matching run log, `EACCES` under
`storage/`, and a stop that does not stop anything. Kill the duplicate before reading anything else.

## Step 1 — the run log

```bash
ls -t "$BOOK_STORAGE_DIR"/<projectId>/runs/          # default ./storage/books
```

Files are `<runId>-<worker-job-name>.jsonl` (kebab: `compile-export`, `generate-page`). Every
provider call is one JSON line, plus lifecycle events written by `processJob.ts`:
`job.start` (with the full payload, the BullMQ opts and a provider-config snapshot), `job.canceled`
(carries the stale reason), `job.already_completed`, `job.recovering`, `job.stopped`, `job.failed`,
`job.superseded`, `job.completed`, `job.follow_up_failed`, `job.completion_bookkeeping_failed`.
The directory is gitignored, so it exists only where the job actually ran — which is itself the
answer to "did the Docker worker or my host worker do this?".

Read these before adding logging.

## Step 2 — the `GenerationJob` row

```sql
select id, type, status, "dedupeKey", "contentRevision", "ownsQualityVerdict",
       "attemptId", "bullJobId", "dispatchAttempts", "nextDispatchAt", error, payload
from "GenerationJob" where "projectId" = '<id>' order by "createdAt" desc limit 25;
```

**`dedupeKey` prefixes tell you which lane queued the row:**

| Shape | Meaning |
| --- | --- |
| `compile-export:{project}:{plan}:{contentFingerprint}` | the generation fan-in compile (`maybeEnqueueCompile`) |
| `compile-export:{project}:{plan}:content-{rev}` | an edit's own recompile (`queueUserEditExportRecompile`) — spent once the row goes terminal |
| `…:repair-{rev}-{window}` / `…:repair-epub-{rev}-{window}` | a detached export repair. `window` is `floor(now / 5min)` — **wall-clock aligned**, not measured from the attempt, so a failed repair blocks the next one for anywhere from a moment to five minutes and never longer (`exportRepairDedupeKey`, `apps/api/src/mobile/exportRepair.ts`) |
| `prepare-characters:{project}:{plan}` | the compile's character-candidate fan-out; a repair carries no attempt, so it computes the bare key |
| `…:attempt:{attemptId}` suffix | appended by `enqueueWorkerJob` for anything belonging to a paid attempt — detached work deliberately gets no suffix |
| `generation-retry:{attempt}:{job}` | the confirmed `/resume` re-charge lane |

**Payload flags change the settlement path.** Check these before reasoning about status or money —
`packages/core/src/jobScope.ts` is the one place they are defined:

- `detachedFromProjectLifecycle` (`DETACHED_FROM_PROJECT_LIFECYCLE`) — the row fails alone. No
  FAILED project, no refund, no project status written on success either.
- `presentationOnlyRecompile` (`PRESENTATION_ONLY_RECOMPILE`) — free reprint of an unchanged
  manuscript; owns its success transition but not the failure/refund path.
- `markdownRecompileWithoutVerdict` — markdown moved but no prose did; owns the lifecycle, not the
  verdict.
- `skipFinalReview` — **not** a detachment signal. An edit's own recompile sets it too, and that is
  charged work whose manuscript is new. Do not use it to infer ownership.
- `exportRepairFormat`, `exportPublicationProjectStatus`, `presentationRecompileFallbackStatus` —
  what a repair was asked to rebuild and what it may publish over.

**`ownsQualityVerdict`** is a *column*, written at row creation from type + payload
(`jobOwnsQualityVerdict`). It is a column because the exclusions are payload flags and a negated
JSON-path predicate in SQL drops every row that never carried the key. `loadProjectQualityReport`
(`apps/api/src/mobile/qualityVerdict.ts`) reads the newest owning compile that has *reported*.

## Step 3 — symptom → where to look

| Symptom | Look at |
| --- | --- |
| Permanent "Preparing PDF" / EPUB button disabled forever | `serializeExportSet` (is the file actually on disk?), then `ensureExportRepairQueuedFor` / `ensureExportRepairQueued` in `apps/api/src/mobile/exportRepair.ts` — repairs are queued only for COMPLETE and REVIEW_REQUIRED. Then the `repair-` row: FAILED means it re-attempts next window. Then the app side: `exportRepairWatchProvider` in `apps/mobile/lib/features/projects/data/export_repair_watch.dart` gives up after 2 minutes against a window of up to 5, so the screen can stop saying "preparing" before the next repair is even queued. |
| Project stuck in `EDITING` | Nothing sweeps EDITING — `reconcileStrandedGeneration` takes only GENERATING and `ensureExportRepairQueued` only COMPLETE/REVIEW_REQUIRED. Check whether `maybeEnqueueCompile` returned `"not-ready"` (or was suppressed by a compile in flight for a superseded revision) and whether `applyBookEdit` restored the settled status. |
| Quality report vanished / "Fix page N" gone | `ownsQualityVerdict` on the recent `COMPILE_EXPORT` rows. A repair or a presentation reprint writing the verdict is the bug; `loadProjectQualityReport` returning nothing because the owning compile fell out of a scan window is the *old* bug and should no longer be possible. |
| A COMPLETE book painted red / "needs attention" | A FAILED detached row reaching `failureMessageForJob` in `apps/api/src/mobile/projectSerializers.ts`, or `canRecoverGenerationJob` (`apps/api/src/mobile/generationRecovery.ts`) accepting it — that predicate refuses rows where `payloadOwnsProjectOutcome` is false, and the status read and the `/resume` write must give the same answer. |
| Deleting a book refunded the purchase | `stopProjectGenerationJobs` in `apps/api/src/queue.ts` — `settleLegacyStoppedJobs`, `BOOK_RUN_JOB_TYPES`, and the filter that excludes detached rows from `legacyJobs`. A status poll queues a repair moments before a delete, and `COMPILE_EXPORT` is in `BOOK_RUN_JOB_TYPES`. |
| Stale PDF after an edit | Publication order in `apps/worker/src/generation/exportPublication.ts`: render to `.book-<uuid>.*`, then claim with `updateMany({ where: { id, contentRevision } })`, then rename. A loser publishes nothing and still COMPLETEs. The API's inline render (`apps/api/src/routes/projectExports.ts`) is a second implementation of the same rule. |
| A download's bytes attributed to the wrong revision | `book.pdf.provenance.json` and `readPublishedExport` (`packages/core/src/generation/exportProvenance.ts`); the route answers `X-Export-Provenance` / `X-Export-Content-Revision`. `mismatch` means a publication is landing under the read. |
| Audiobook failure failed the book | `generate-audiobook` is in `DERIVATIVE_GENERATION_JOBS`, and `markFailed`/`markStopped` in `apps/worker/src/runtime/jobLifecycle.ts` route it to `failAudiobookForJob` with an early `return` — before the default branch that sets the project FAILED and refunds `FULL_BOOK_GENERATION`. Check the early return actually fired; the same shape covers `generate-character-portrait` (`failCharacterPortraitForJob`) and `plan-book` (`refundPlanGenerationForJob`). |
| Narration restarts from chapter 1 | The route reuses a FAILED `Audiobook` row only when the voice and `contentRevision` still match; the worker's READY-skip has nothing to skip otherwise. |
| Charged twice | `startGenerationAttempt`'s `commandKey` + `requestFingerprint` claim and its `replayed` flag; then `scripts/audit-duplicate-generation-charges.ts`. |
| Job dispatched but never ran | `bullJobId` null with `dispatchAttempts` climbing → `reconcileUndispatchedWorkerJobs`. `bullJobId` set with no run log → the other worker took it (step 0). |
| Job cancelled immediately on pickup | `staleGenerationJobReason` in `apps/worker/src/runtime/jobLifecycle.ts`, logged as `job.canceled` with the reason. |

## Step 4 — two settlement implementations; establish which one ran

This is the correction most often needed before a fix is proposed:

- **Worker side** — `apps/worker/src/runtime/jobLifecycle.ts`: `markFailed` / `markStopped` /
  `markRecovering`, gated by the private `jobOwnsProjectLifecycle(job)`, refunding through
  `refundFailedProjectCredits`. Its success-side twin is the local `ownsProjectStatus` in
  `apps/worker/src/handlers/compileExport.ts`.
- **API side** — `apps/api/src/queue.ts`: `stopProjectGenerationJobs`, which every stop route and
  *both* delete routes go through, with its own `settleLegacyStoppedJobs`, `BOOK_RUN_JOB_TYPES` and
  `SETTLED_PROJECT_STATUSES`.

They are second copies, not wrappers. A user stop, a delete and a worker crash take different code
to the same rows. Determine from the run log and the row's `error`/`message` which one wrote the
verdict — `Stopped` / `Stopped by user` (`STOPPED_JOB_MESSAGE` / `STOPPED_JOB_ERROR`) points at a
stop path — and fix both if the rule itself is wrong.

## Step 5 — reproduce, then repair

Reproduce with mock adapters, which exercise the whole pipeline with no tokens or network:

```bash
MOCK_AI=true pnpm dev:api
MOCK_AI=true pnpm dev:worker
```

Repair and audit scripts (run with `pnpm exec tsx`, from the repo root, with the same `DATABASE_URL`
and `BOOK_STORAGE_DIR` as the environment you are fixing). **All three default to a dry run and
mutate only under `--apply`**, and none of them are documented anywhere else:

```bash
pnpm exec tsx scripts/repair-plan-from-run-log.ts --project <id> [--log <path>] [--apply]
pnpm exec tsx scripts/repair-stuck-plan-revisions.ts [--project <id>] [--apply]
pnpm exec tsx scripts/audit-duplicate-generation-charges.ts [--project <id>] [--apply]
```

- `repair-plan-from-run-log.ts` reconstructs a lost plan from the planner's own run log; it refuses
  the destructive path when the project already has generated artifacts.
- `repair-stuck-plan-revisions.ts` settles plan revisions left mid-flight.
- `audit-duplicate-generation-charges.ts` reports duplicate charges per generation job and, with
  `--apply`, refunds the duplicates through `refundCreditLedgerEntry` — read the dry-run output in
  full first; it also emits a separate "review" bucket it will not touch.

Print the dry run, decide, then re-run with `--apply`. Never propose a schema or settlement change
before step 0 and step 4 have both been answered.
