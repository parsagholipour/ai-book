# Operator console

React/Vite. The internal console behind the `WEB_PASSWORD` cookie — not a customer surface, and the
only consumer of `/api/admin/*`.

`src/features/`: `admin` (the `/admin` dashboard — overview, users, moderation), `pricing` (writes
`CreditPricingRevision`), `projects`, `planning`, `voice`, `jobs`, `auth`, `legal`, `previews`.

This workspace is by far the least tested (8 test files, ~700 lines against ~13k of source), so
lean on typecheck here and be careful with changes that only show up at runtime.

## It mirrors the server by hand

The console owns no invariant of its own, but it re-states several. When you change one of these on
the server, check here:

- **Job step labels.** `src/jobsDisplay.ts` carries fallback labels for rows without
  server-provided steps, mirroring `JOB_STEP_TEMPLATES` in `packages/core/src/jobSteps.ts`. This
  is the one mirror still maintained by hand: `apps/web` cannot import `@book-maker/core` today —
  it has no dependency on it, a relative import fails its `rootDir`, and core's single barrel
  export pulls in puppeteer, sharp and `node:fs`, which a Vite browser build cannot take.
  Deriving it needs a `workspace:*` dependency plus a `"./jobSteps"` subpath export on core, so
  the barrel stays out of the bundle. Until then, a new job type must be added here too.
- **Plan questions.** `PlanQuestionStepper` must obey `answerKind` the same way the app's pickers
  do, and a joined multi-answer is kept in `QuestionResponse.picked` so it is not mistaken for a
  typed custom answer.
- **Pricing.** The `/pricing` screen edits the operator-editable price table; the shapes come from
  `packages/core/src/creditPricing.ts`. Anything projecting revenue must iterate `CREDIT_PRICE_KEYS`
  rather than every key, or it invents income from the free tier's *limit* keys.
- **Exports.** The console downloads via a plain link, so its export routes render inline rather
  than queueing a repair — see `apps/api/src/routes/CLAUDE.md`.

`src/features/voice/BrowserVoiceRoomClient.ts` and `BrowserVoiceCallClient.ts` are the two largest
files in the repo and both sit near their grandfathered size ceilings; split rather than grow them.

<!-- gotcha-index: pointer-only -->
