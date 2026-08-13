# Scripts

Repo tooling, ops repairs and the render harnesses. Four of these are not in `package.json` and are
found only by listing this directory.

## Checks (wired into `pnpm check`)

- `check.mjs` — the gate runner. Runs typecheck, lint, the size budget, the gotcha index and all
  tests **unconditionally**, reports every failure rather than stopping at the first, and exits
  nonzero if any gate failed.
- `check-file-sizes.mjs` — fails when a `.ts`/`.tsx`/`.dart` file passes 900 lines. The
  `GRANDFATHERED` map holds explicit ceilings for files that were already over. **Those entries are
  debts, not permissions** — split along a real seam instead of raising a number. The script prints
  a `note:` when a listed file drops back under the default so the entry can be deleted.
- `check-gotcha-index.mjs` — asserts the invariant index in the root `CLAUDE.md` and the
  directory-scoped `CLAUDE.md` files still agree.

## Render harnesses

- `render-book-fixtures.ts` (`pnpm render:fixtures`) — renders the seven-book fixture corpus.
  This is how a typesetting change is proved; see the `verify-pdf-typography` skill. Not a test.
- `preview-cover-designs.ts` (`pnpm covers:preview`) — contact sheet of the cover catalog.
- `generate-audiobook-samples.ts` (`pnpm audiobook:samples`) — narrator sample MP3s.

Anything that launches Chromium must go through the shared browser pool and must call
`closeSharedBrowser()` when done, or the process will not exit.

## Ops (all `--apply`-gated; they default to a dry run)

- `audit-duplicate-generation-charges.ts` (`pnpm billing:audit-duplicates`) — duplicate credit
  charges per `GenerationJob`, and can refund them.
- `repair-plan-from-run-log.ts` — rebuilds a project's plan from its provider run log.
- `repair-stuck-plan-revisions.ts` — projects whose plan revision job finished but whose plan never
  advanced.
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
