# Worker

Consumes the `book-maker` BullMQ queue. All book generation happens here; the API never generates.

## Adding a job type

1. Add the value to `enum JobType` in `packages/db/prisma/schema.prisma`, then `pnpm db:generate`.
2. Add a handler in `src/handlers/`, exporting `async function myJob(job: Job)`.
3. Register it in the `switch (job.name)` in `src/index.ts`.
4. Add its progress steps to `JOB_STEP_TEMPLATES` in `src/runtime/jobLifecycle.ts` — the mobile
   app renders those step labels, so a missing entry shows an empty progress list.
5. Enqueue it through `enqueueWorkerJob` in `src/runtime/dispatch.ts`, never `queue.add` directly.

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

## Stopping and failure

`StopRequestedError` (from `runtime/jobTypes.ts`) means the user stopped the run — it converts to
an `UnrecoverableError` so BullMQ does not retry. Anything else goes through
`shouldRecoverJobAttempt` in `runtime/jobLifecycle.ts`, which wraps the pure policy in
`runtime/jobRetryPolicy.ts`. Failed paid work must refund; see `refundFailedProjectCredits`, also
in `runtime/jobLifecycle.ts`.
