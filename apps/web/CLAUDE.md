# Operator console

React/Vite. The internal console behind the `WEB_PASSWORD` cookie — not a customer surface, and the
only consumer of `/api/admin/*`.

`src/features/`: `admin` (the `/admin` dashboard — overview, users, moderation), `pricing` (writes
`CreditPricingRevision`), `projects`, `planning`, `voice`, `jobs`, `auth`, `legal`, `previews`.

This workspace is by far the least tested (8 test files, ~700 lines against ~13k of source), so
lean on typecheck here and be careful with changes that only show up at runtime.

## The core dependency is linked, never installed for

**This workspace depends on `@book-maker/core` to *bundle* it, so its Docker filter carries no
`...`.** `api` and `worker` run core's source through node and need its dependencies present, which
is what `DEV_PNPM_FILTER: "@book-maker/<svc>..."` buys them. Web only ever hands the source to
vite, so `docker-compose.yml` filters it as plain `@book-maker/web`: pnpm still writes the
`apps/web/node_modules/@book-maker/core` symlink for a workspace dependency of the selected
project, and vite resolves `./qualityGates` straight out of the bind-mounted source with
`packages/core/node_modules` left empty. Adding the suffix selects packages/core as a project to
*install for* — 437 packages in this container instead of 263, with puppeteer, sharp, openai and
md-to-pdf among them, to compile two `const` arrays down to fourteen strings. Chromium itself is
not the cost anyone should fear: the `base` stage of the `Dockerfile` sets
`PUPPETEER_SKIP_DOWNLOAD=true` and points `PUPPETEER_EXECUTABLE_PATH` at the apt-installed
`/usr/bin/chromium`, and every service image inherits it. That flag belongs to the Dockerfile and
must not migrate to `.npmrc`, which the host reads too — a developer's `pnpm install` is what
fills `~/.cache/puppeteer`, and nothing in the code sets `executablePath`, so a global skip would
leave host PDF tests with no browser to launch.

What holds this up is that `./qualityGates` imports one *type* and nothing else, so the module vite
serves has no import statement at all. That rule was already the reason the subpath exists (see
`packages/core/CLAUDE.md`); it is now also what keeps this container's dev server resolving. Give
that module — or anything it reaches — a runtime import and this container fails at **request
time** with an unresolvable `zod` or `sharp`, while `pnpm check`, `vite build` on the host and every
test stay green, because the host tree has a full install. What counts as "a type import" is itself
a compiler setting: `import { type X } from "y"` survives as `import {} from "y"` once
`verbatimModuleSyntax` is on, so the gate reads that option instead of assuming it and
`tsconfig.base.json` pins it to `false` beside a note saying why (→ `packages/core/CLAUDE.md`).

Nothing used to catch that, which is why the rule is no longer prose. `scripts/check-core-subpaths.mjs`
asserts the runtime closure of every narrow subpath in `packages/core/package.json` is empty, and
runs as the `subpaths` gate in `pnpm check`. It reads this service's `DEV_PNPM_FILTER` out of
`docker-compose.yml` so its failure message explains the container rather than restating it from
memory — and prints a note if the filter is ever widened back, since that would quietly retire the
reason the gate exists. Widening it is not the fix.

**This container is a dev server and nothing else — its non-dev scripts do not work in there.**
`pnpm dev` is vite and `pnpm test` is vitest; both erase type imports through esbuild before
resolving anything, so both are green inside the container. `pnpm typecheck` and `pnpm build` are
not, and cannot be: `tsc` follows `@book-maker/core/qualityGates` into
`packages/core/src/schemas/mediaSettings.ts`, which imports `zod` at the value level, and with
`packages/core/node_modules` empty there is nothing to resolve it against — four
`TS2307: Cannot find module 'zod'` and five implicit-`any` errors that follow from them, all inside
`packages/core`, before a line of `apps/web` is checked. That was measured in a freshly installed
`web` container, not inferred; the same container serves every core-importing module at 200 and runs
its own vitest suite green. It is nobody's workflow: the service's `command` is
`pnpm --filter @book-maker/web dev`, its `DEV_DEPS_PACKAGE` sentinel is `vite`, no `make` target
execs into it, there is no CI, and the root `pnpm typecheck` could never have run there anyway
because api, worker and db are not installed either. So this is documented rather than fixed —
widening the filter to serve a workflow nobody has would cost 437 packages *and* retire the reason
the `subpaths` gate exists. Run the gates on the host, where `pnpm check` and
`pnpm -F @book-maker/web typecheck` have the full install; if you genuinely need `tsc` in a
container, the `api` one installs the whole workspace.

One trap that looks identical to a violated invariant but is not: the node_modules volumes are
stamped with the filter plus the lockfile hash (`scripts/docker-dev-entrypoint.sh`), so a container
still up from before `@book-maker/core` was added to `package.json` here has no
`apps/web/node_modules/@book-maker/core` link at all, and vite answers **both** subpath imports with
`Failed to resolve import "@book-maker/core/jobSteps"`. That is a stale volume, not a subpath that
grew an import — `docker compose restart web` reinstalls against the current lockfile and both
resolve again.

**The dependency is on the barrel too, and the barrel is the dangerous half.** `package.json` here
carries `@book-maker/core: workspace:*`, which buys `@book-maker/core/qualityGates` and the bare
`@book-maker/core` in the same breath. Nothing in the toolchain tells them apart: `import
{ jobNames } from "@book-maker/core"` — the obvious way to stop hand-copying the job-step labels
below — typechecks, bundles under `vite build` and passes vitest on the host, then fails in this
container at request time, on a `puppeteer` that is not installed there. Proving the narrow subpaths
runtime-empty does not cover that, because the gate's file list is the `exports` map and `.` is
never in it. So the same script also walks this workspace's own source and fails any **value**
import of the barrel, of a subpath core does not export, or of a relative path into
`packages/core/src`. `import type { … } from "@book-maker/core"` is fine — erased before vite
resolves anything. It scans this workspace because `docker-compose.yml` installs it with a filter
that has no `...` tail, not because the script names `apps/web`: any service installed that way is
scanned on the same rule, and widening the filter turns the scan off rather than making the import
safe. When a module here genuinely needs something off core, add the subpath export and let the
other half of the gate prove it is empty — that is the sanctioned route, and `./jobSteps` is what it
looks like walked end to end: a leaf measured, an entry added, a hand-copy deleted.

## It mirrors the server by hand

The console owns no invariant of its own, but it re-states several. When you change one of these on
the server, check here:

- **Job step labels — no longer one of these.** `src/jobsDisplay.ts` carries fallback labels for
  rows without server-provided steps, and it now derives them from `JOB_STEP_TEMPLATES` through
  core's `./jobSteps` subpath instead of restating them. A new job type needs nothing here: core's
  table is exhaustive over `GenerationJobType` by type, so the entry that makes core compile is the
  entry the console renders. A type this build has no template for — an API ahead of the console —
  renders its row with no step list rather than throwing, which is how core's own
  `generationJobTypeForWorkerName` answers a name it does not know. Never the barrel: it pulls in
  puppeteer, sharp and `node:fs`, which a Vite browser build cannot take — and the `subpaths` gate
  refuses that import here rather than leaving it to the container.
- **Plan questions.** `PlanQuestionStepper` must obey `answerKind` the same way the app's pickers
  do, and a joined multi-answer is kept in `QuestionResponse.picked` so it is not mistaken for a
  typed custom answer. Option normalization takes case-sensitive `uniqueStrings` through core's
  zero-dependency `./collections` subpath; never replace that with a barrel import.
- **Pricing.** The `/pricing` screen edits the operator-editable price table; the shapes come from
  `packages/core/src/creditPricing.ts`. Anything projecting revenue must iterate `CREDIT_PRICE_KEYS`
  rather than every key, or it invents income from the free tier's *limit* keys.
- **Exports.** The console downloads via a plain link, so its export routes render inline rather
  than queueing a repair — see `apps/api/src/routes/CLAUDE.md`.

`src/features/voice/BrowserVoiceRoomClient.ts` and `BrowserVoiceCallClient.ts` are the two largest
files in the repo and both sit near their grandfathered size ceilings; split rather than grow them.
