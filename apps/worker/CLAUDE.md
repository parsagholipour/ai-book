# Worker

Consumes the `book-maker` BullMQ queue. All book generation happens here; the API never generates.

## Adding a job type

1. Add the value to `enum JobType` in `packages/db/prisma/schema.prisma`, then `pnpm db:generate`.
2. Add a handler in `src/handlers/`, exporting `async function myJob(job: Job)`.
3. Register it in the `switch (job.name)` in `src/processJob.ts`.
4. Add its progress steps to `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts` — the mobile
   app renders those step labels. That table is `Record<GenerationJobType, …>`, so a missing entry
   is a compile error rather than an empty progress list. `src/runtime/jobProgress.ts` only
   translates the kebab job name to the type and reads it.
5. Enqueue it through `enqueueWorkerJob` in `src/runtime/dispatch.ts`, never `queue.add` directly.
   It takes a `type` and derives the BullMQ name itself; add the type to `WORKER_FANOUT_JOB_TYPES`
   there if the worker fans it out.

The full cross-workspace footprint is about fourteen files — the four lists above are only the
worker's share. Use the `add-job-type` skill, which walks the rest.

## Layers

`handlers/` may import from `generation/`, `providers/`, and `runtime/`. Nothing imports back into
`handlers/`. If two handlers need the same logic it belongs in `generation/`.

`runtime/queue.ts` opens a Redis connection at import time. Only `index.ts` and `runtime/dispatch.ts`
import it. Keeping handlers off it is what lets them be imported in tests without a broker.

## Providers

Handlers never construct adapters. `createLoggedProviders(job, providers, input)` in
`providers/loggedAdapters.ts` wraps a job's provider set so every call is:

- appended to the run log at `<BOOK_STORAGE_DIR>/<projectId>/runs/<run>-<job>.jsonl`
- costed into `ProviderCallLog` (opened "live" when streaming starts, settled on completion)
- checked for a user stop request, which raises `StopRequestedError`
- retried on recoverable network errors, and for images, failed over to the other provider

If you add a provider call, route it through this wrapper or it will be invisible to both the
cost accounting and the progress UI.

Note that `providers/` holds **no model adapters** — only these logging and accounting wrappers.
The adapters themselves are in `packages/core/src/adapters/`.

## Stopping and failure

`StopRequestedError` (from `runtime/jobTypes.ts`) means the user stopped the run — it converts to
an `UnrecoverableError` so BullMQ does not retry. Anything else goes through
`shouldRecoverJobAttempt` in `runtime/jobLifecycle.ts`, which wraps the pure policy in
`packages/core/src/jobDispatch.ts`. Failed paid work must refund; see `refundFailedProjectCredits`,
also in `runtime/jobLifecycle.ts`.

## Queue state and run logs

- **Generation state lives in the database, not in Redis.** A `GenerationJob` row is written
  first, then pushed to BullMQ; `reconcileUndispatchedWorkerJobs` re-pushes anything that was
  persisted but never reached Redis. Preserve that order or a crash between the two strands a book.
- **Run logs are the debugging artifact.** Every provider call is appended as JSON lines under
  `<BOOK_STORAGE_DIR>/<projectId>/runs/`. Read those before adding new logging.

## Where the rest of the invariants live

The worker owns a book's outcome, so several of the rules it must respect are enforced by code in
other packages. Read these before changing anything that compiles, publishes, or settles:

- `src/generation/CLAUDE.md` — a compile publishes by *claiming* the revision it compiled; the
  reader-chapter cache and when a compile may not make a model call; character reference sheets.
- `src/handlers/CLAUDE.md` — per-job rules: cover fallback, the project-less portrait job,
  audiobook failure semantics, narration chaptering and timings.
- `packages/core/src/generation/CLAUDE.md` — the browser pool. `index.ts` must trap **SIGHUP**
  alongside INT/TERM and its `shutdown()` must await `closeSharedBrowser()`, or a hangup leaves a
  Chromium reparented to init and reaped by nobody. Budget two pooled browsers in production, one
  per process.
- `packages/db/CLAUDE.md` — failed paid work must refund on **every** path, including the ones
  that are not a thrown error.
- `apps/api/src/mobile/CLAUDE.md` — `apps/api/src/queue.ts` `stopProjectGenerationJobs` is a whole
  parallel implementation of the settlement logic in `runtime/jobLifecycle.ts`. A change to how a
  stopped or detached job settles has to be made in both, or a stop and a worker failure will
  disagree about the same row.
