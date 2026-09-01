# Scripts

Repo tooling, ops repairs and the render harnesses. Four of these are not in `package.json` and are
found only by listing this directory.

## Checks (wired into `pnpm check`)

- `check.mjs` — the gate runner. Runs typecheck, lint, the size budget, the gotcha index, the core
  subpath closure, its `node:test` suite and every workspace's Vitest suite **unconditionally**,
  reports every failure rather than stopping at the first, and exits nonzero if any gate failed.
  `--only <gate>` runs one; `--list` names all seven (`subpath-tests` is the checker unit suite).
  **A gate whose script is gone fails; it does not skip.** `requires` on a gate turns an absent
  script into a SKIP, and only `gotchas` carries it — that was a landing-order concession for a
  script arriving in a separate change, and it should come off once nothing is mid-landing. Every
  other script-backed gate enforces something that used to be enforced by nothing, so going green
  on a deleted script is the false green this runner exists to remove. What that costs — a missing
  script and a real violation both exiting 1 — is paid back by `missingScript`: a node-run gate
  with no `requires` whose script is absent is failed *before* it is spawned, and the summary says
  `script missing: <path>` where a violation says `exit 1`. Read the summary line, not just the
  colour.
- `check-file-sizes.mjs` — fails when a `.ts`/`.tsx`/`.dart` file passes 900 lines. The
  `GRANDFATHERED` map holds explicit ceilings for files that were already over. **Those entries are
  debts, not permissions** — split along a real seam instead of raising a number. The script prints
  a `note:` when a listed file drops back under the default so the entry can be deleted.
- `check-gotcha-index.mjs` — asserts the invariant index in the root `CLAUDE.md` and the
  directory-scoped `CLAUDE.md` files still agree.
- `check-core-subpaths.mjs` — one invariant checked from both ends. **Producer side**: every narrow
  subpath in `packages/core/package.json`'s `exports` map has an **empty** transitive runtime
  closure — following value imports only, it reaches no module and no package. **Consumer side**:
  every value import of `@book-maker/core` from a workspace whose container installs it *without*
  core's dependencies names one of those subpaths. The web dev container installs `@book-maker/web`
  alone, so `packages/core/node_modules` is empty there and vite serves those modules out of
  bind-mounted source — a value import breaks that container at request time and nothing else, on a
  host with a full install. Neither half stands alone: the producer side's file list comes off the
  `exports` map, which by construction never holds `.`, so the barrel — the one import that actually
  breaks the container, and a declared `workspace:*` dependency of `apps/web` — is invisible to it;
  the consumer side needs the producer side's list to know what a file is allowed to name instead.
  Both lists are derived, never copied: the subpaths from `package.json`, the consumers from the
  `DEV_PNPM_FILTER`s in `docker-compose.yml` (no `...` tail means the project installs alone). A
  fifth subpath, or a second narrowly-installed service, is covered the moment it lands. **So is
  the definition of an erased import**: a named import whose every specifier is inline `type` is
  free only while `verbatimModuleSyntax` is off, so the script reads that option out of the tsconfig
  governing each tree it walks (`extends` followed nearest-wins) rather than assuming it. Turn it on
  and `import { type X } from "y"` emits `import {} from "y"`; the gate then counts it, names the
  setting in the failure, and points at the statement-level `import type` spelling. A tsconfig it
  cannot read fails for the same reason an unreadable filter does. On a green run it prints which
  statements are erased *only* by that option — one today, `packages/core/src/jobSteps.ts:1` — so
  the assumption is in the output rather than in a comment. `tsconfig.base.json` pins the option to
  `false` beside a note pointing back here; the pin is the signpost and the gate is the enforcement.
  String and no-substitution template specifiers resolve normally; computed `import()`/`require()`
  arguments in a producer closure are unresolved runtime edges and fail closed instead of
  disappearing from the walk. On the consumer side, only a computed expression whose own literal
  pieces can construct `@book-maker/core` or a relative path into `packages/core/src` fails; an
  unrelated local/plugin expression is outside this gate, and identifiers are not constant-traced.
  See `packages/core/CLAUDE.md` and `apps/web/CLAUDE.md`.

## Render harnesses

- `render-book-fixtures.ts` (`pnpm render:fixtures`) — renders the eight-book fixture corpus.
  This is how a typesetting change is proved; see the `verify-pdf-typography` skill. Not a test.
- `preview-cover-designs.ts` (`pnpm covers:preview`) — contact sheet of the cover catalog.
- `generate-audiobook-samples.ts` (`pnpm audiobook:samples`) — narrator sample MP3s.

Anything that launches Chromium must go through the shared browser pool and must call
`closeSharedBrowser()` when done, or the process will not exit.

## Offline evaluation

- `replay-anti-slop-calibration.ts` (`pnpm anti-slop:replay`) — distilled-fixture replay of the
  anti-slop corpus (`replayAntiSlopCalibration`). No `storage/`, no live books. Exit 1 if a
  fixture fails. Full manuscripts stay a local caller of `replayDeterministicManuscriptChecks`.


## Ops (all `--apply`-gated; they default to a dry run)

- `audit-duplicate-generation-charges.ts` (`pnpm billing:audit-duplicates`) — duplicate credit
  charges per `GenerationJob`, and can refund them.
- `repair-plan-from-run-log.ts` — rebuilds a project's plan from its provider run log.
- `repair-stuck-plan-revisions.ts` — projects whose plan revision job finished but whose plan never
  advanced.
- `clear-character-reference-refusals.ts` — takes back a recorded character reference refusal. A
  provider that declines to draw a character settles that cast for the life of the plan version and
  nothing else in the tree ever clears the column, so a false positive from the refusal classifier
  used to cost a replan. `--project` / `--plan` / `--character` narrow it, and it skips a plan whose
  render lease is live. Clearing only *unsettles* the set: the next `generate-image` or
  `generate-cover` job for that plan is what redraws the cast, which for a finished book means
  asking for a picture afterwards. See `apps/worker/src/generation/CLAUDE.md`.
- `check_alibaba_credentials.py` — standalone Python probe; redacts secrets.

## Process entry points

`start-production.sh`, `docker-dev-entrypoint.sh` and `tsx-dev.mjs` are part of the Chromium
shutdown story, not just launchers. All three must forward or trap **SIGHUP** alongside INT/TERM:
puppeteer's own handlers are off, so a hangup that Node does not handle never reaches its
`process.on("exit")` net and leaves a Chromium reparented to init. `tsx-dev.mjs` forwards a hangup
as **SIGTERM**, because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans
the app holding the browser. See `packages/core/src/generation/CLAUDE.md`.

`docker-dev-entrypoint.sh` sets `umask 0000` so the host user can write into directories the
container created first. A stray `EACCES` under `storage/` means two stacks are running, not that
permissions need loosening further.

<!-- gotcha-index: pointer-only -->
