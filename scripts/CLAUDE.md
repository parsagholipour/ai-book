# Scripts

Repo tooling, ops repairs and the render harnesses. Five of these are not in `package.json` and are
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

## Live storybook acceptance

- `storybook-acceptance.ts` — prepares matched Quick/Balanced/Premium rounds from a
  saved 30-page operator input, with explicit experimental performance ceilings.
  Start optimization validation with one round. `prepare` only writes local fixtures;
  `launch` requires a drained local queue, one worker and real providers. See
  [storybook-acceptance.md](storybook-acceptance.md) for the runbook.
- `generation-acceptance.mjs` — terminal outcome and download integrity checks,
  shared with `dev-rerun-book.ts`. A manuscript capture is diagnostic evidence,
  never proof of publication. Failed or canceled compiles return nonzero even
  when manuscript files exist. Download capture verifies all three formats and
  their exact content revision; it does not enqueue an export repair.
- `generation-performance.mjs` — reports elapsed stages and provider attempts from
  saved jobs/logs. A functional export pass alone does not pass the benchmark.
- `generation-acceptance.test.mjs` runs in the existing `subpath-tests` gate of
  `pnpm check`, alongside the subpath checker tests.


## Ops (all `--apply`-gated; they default to a dry run)

- `audit-duplicate-generation-charges.ts` (`pnpm billing:audit-duplicates`) — duplicate credit
  charges per `GenerationJob`, and can refund them.
- `repair-plan-from-run-log.ts` — rebuilds a project's plan from its S3 provider run log.
  `--log-file` names an S3 run key. Storage inspection follows [storage.md](../docs/storage.md).
- `repair-stuck-plan-revisions.ts` — projects whose plan revision job finished but whose plan never
  advanced.
- `clear-character-reference-refusals.ts` — takes back a recorded character reference refusal. A
  provider that declines to draw a character settles that cast for the life of the plan version and
  nothing else in the tree ever clears the column, so a false positive from the refusal classifier
  used to cost a replan. `--project` / `--plan` / `--character` narrow it, and it skips a plan whose
  render lease is live. Clearing only *unsettles* the set: the next `generate-image` or
  `generate-cover` job for that plan is what redraws the cast, which for a finished book means
  asking for a picture afterwards. See `apps/worker/src/generation/CLAUDE.md`.
- `migrate-legacy-images.ts` — copies pictures that exist only under the historical
  `storage/images/` into the object store: `ImageAsset` rows (`images/<projectId>/<file>`) and
  `LibraryCharacterImage` rows (`images/characters/<userId>/<file>`) whose object is missing.
  `putIfAbsent`, so nothing stored is overwritten. Run it inside the api container (the host has no
  object-store credentials), and check `df` first: MinIO refuses writes under ~1% free, and the
  dry run prints the bytes an `--apply` adds.
- `comp-plan.ts` — gives a reader a paid plan for free (`--email`, `--tier creator|pro|max`,
  `--note`), or takes it back (`--revoke`). The comp is a plan entitlement with
  `source: "operator_comp"` and no purchase record; each month's allowance is granted lazily on the
  reader's first request of that month, counted from the day it was given, so nothing re-runs
  monthly. Refuses an account that already holds a Google Play plan. See
  `packages/db/src/operatorPlanComps.ts`.
- `check_alibaba_credentials.py` — standalone Python probe; redacts secrets.

## Production deploy

`deploy-production.sh` runs on the EC2 host through SSM (`deploy-via-ssm.py` ships it beside the
compose file); `check-production-docker.sh` is CI's smoke test of the same images. One disk holds
the OS, every Docker image, and the PostgreSQL and Redis volumes, so image bytes are a database
availability question. The whole story is in `docs/deployment.md`, "Image retention and the disk
guard". The host scripts have Python tests that stub docker and aws through `BASH_ENV` and touch
nothing real: `python3 -m unittest discover -s scripts -p 'test_*.py'` runs them all, and the
Terraform workflow's validate job runs the same line before every apply and deploy.
`test_deploy_production.py` holds the cutover order and every failure path below;
`test_worker_healthcheck.py` the healthcheck against a fake Redis.

**The dependency layer is built from manifests alone, or every deploy ships a new gigabyte.** The
Dockerfile's `manifests` stage reduces `apps/` and `packages/` to their `package.json` files, and
both installs, `build`'s full one and `runtime-deps`' production one, see only that, the lockfile,
`pnpm-workspace.yaml`, the root `package.json` and `.npmrc`. Until 2026-10 the sources were copied
before `pnpm install`: every commit re-ran it, the new ~1 GB layer had a new digest, and the host
pulled and kept another gigabyte per deploy until launch week's hotfixes filled the disk. Anything
the install reads (a patch file, a `pnpm` field, a `postinstall` input) has to reach it through
those copies, never after them. The app image installs `--prod` for `@book-maker/api...` and
`@book-maker/worker...` only, so a package a production process loads must be in its own
workspace's `dependencies`. That is why `tsx` (every process runs TypeScript through it) and
`prisma` (`migrate` runs `prisma migrate deploy`, then seeds through tsx) are dependencies, not
devDependencies. A devDependency imported at runtime passes `pnpm check`, because the host has a
full install, and fails only in the image.

**The host keeps the current and previous release's images by name; `docker image prune` would delete the rollback.**
Compose pulls by digest, so release images carry no tag, and Docker counts an untagged image as
dangling once no container uses it. That is the previous release the moment
the new one starts. `prune_images` keeps the images named by `/opt/book-maker/current/images.env`
and `previous/images.env` (and, before the pull, the incoming release's) plus every image a
container uses, deletes every other image, and deletes nothing if a read fails. It never touches
volumes. `previous` moves only when the outgoing release ran different images, so a rerun does not
make the rollback the release itself. The pull is refused under 4 GiB free (a base-image change
brings the whole ~2 GiB app image) and the cutover under 2 GiB, measured on the fuller of
DockerRootDir and `/var/lib/containerd`, because the containerd image store keeps its layers
outside DockerRootDir.

**Postgres and Redis are the last things the kernel may kill, and every Node process knows its heap ceiling.**
Until 2026-10 production was a t3.small, 2 GiB with no swap and no limits (infra review): one
large illustrated compile could wake the OOM killer, and a single killed Postgres backend makes
the postmaster reset every connection, so billing transactions roll back mid-flight and running
jobs fail; or the box thrashes until SSM stops answering while EC2's status checks still pass.
`docker-compose.production.yml` now gives postgres and redis `oom_score_adj: -900` (every backend
inherits it) and **no** `mem_limit`, because a cgroup kill inside Postgres is the same reset; they
are bounded by their own settings instead, Redis by `maxmemory 256mb` under the `noeviction`
BullMQ requires, where a full Redis refuses writes loudly rather than eating a host it is
protected on. The api and worker get hard ceilings with no swap of their own (`memswap_limit`
equal to `mem_limit`: 1 GiB and 2 GiB, sized for `main.tf`'s t3.medium), the worker
`oom_score_adj: 500`, and `--max-old-space-size` on each Node command line (512 and 768 MiB) so V8
collects, or fails with a heap error, before the cgroup SIGKILLs it. Chromium is a child process in
the same cgroup, which is why the worker's heap is well under half its ceiling; left alone, Node 22
takes half. The flag is on the command line because a per-service `environment:` would replace the
`x-app` anchor's whole map. `prepare-production-swap.sh` (`aws_ssm_association.swap` in `swap.tf`,
tested by `test_prepare_production_swap.py`) adds the 2 GiB `/swapfile` with `vm.swappiness = 10`
for everything that has no ceiling. It never switches off or rewrites an active swapfile on a
rerun, and refuses to create one that would leave less than the deploy's 4 GiB pull floor.
`deploy-production.sh` brings postgres and redis up only after the worker has drained and the API
has stopped, because a changed definition recreates them. Change any of these numbers and redo the
sum in `docs/deployment.md`, "Memory budget and swap"; a second worker container is a new row there,
not a copy of the worker service.

**The worker drains while the API still serves, so a deploy's outage is the API's stop, the dump, the migration and the start.**
Until 2026-10 the deploy stopped worker, api and web in one command, so the whole site answered
502 for the worker's drain (up to `stop_grace_period`, five minutes) as well, about 6–8 minutes
a push (launch review H1). Now `stop worker` runs alone first: the worker keeps beating while it
drains (`apps/worker/CLAUDE.md`, "Liveness"), so `/api/ready` and the alert sweep stay quiet, and
work the API queues meanwhile waits in Redis for the new worker. Only then `stop api web`. The
preflight (`checkProductionConfig`) and the disk guard still run before anything stops. Pushes
that change only `docs/`, `.scratch/`, `.claude/` or Markdown do not deploy at all (`paths-ignore`
in `.github/workflows/terraform.yml`; a push is skipped only when every file it changes matches).
`apps/mobile/` was on that list until the Flutter web build moved into the web image (2026-10-18);
a push that changes only it now deploys without the cutover, below.

**A release that changes only the web image replaces web alone, so an unchanged app image is reused, never rebuilt.**
When the Flutter web build went into the web image, every `apps/mobile` push started taking the
full cutover above, outage and worker drain included, to swap static files in nginx. Now
`web_only_release` in `deploy-production.sh` takes the short path when the incoming app image
digest, `.env` and compose file are byte-identical to `current`'s, the API and worker are running,
and `$root/cutover-incomplete` is absent: `up -d --no-deps web`, then Caddy and the edge check, with
`phase=web`, whose failure puts the running release's `WEB_IMAGE` back (nothing else changed, so
that is safe where a full cutover's failure is not). The marker is written before a full cutover
stops anything and removed only once a release is live, because a cutover that failed partway can
leave the API and worker stopped or running images `current` does not name, and the short path
would trust them. The `.env` test is what makes a `PRODUCTION_ENV` or `DEBUG_MODE` change on an
unchanged commit restart the API and worker. The digest test only works because CI never rebuilds
an unchanged app: buildx attaches fresh provenance to every build, so even a fully cached rebuild
has a new digest and would take the full cutover every time. `deploy.yml` hashes `git ls-files -s`
of every tracked file but `apps/mobile`, `docs`, `.scratch` and `.claude`, tags each app build
`src-<key>-<run>-<attempt>` (ECR tags are immutable, so a forced rebuild cannot reuse the bare key)
and deploys the newest image carrying the key instead of building. What it hashes is
deliberately more than the image reads, never less: a path wrongly left out would deploy a stale
API and worker with no error anywhere. The Flutter build is cached the same way by
`apps/mobile` and `scripts/build-flutter-web.sh`, and saved only after analysis and the browser
tests pass. The `rebuild` input on the Terraform workflow's manual run skips both lookups.

**Nothing is migrated until the database it changes is in S3.** A migration that adds enum values
the running images cannot read (`000075`–`000102` do) has no rollback but a restore, and until
2026-10 there was nothing to restore from (launch review B5). After the API stops and postgres is
up, `dump_database` streams `pg_dump --format custom` from the postgres container straight into
`s3://<assets bucket>/db-backups/<UTC time>-<release>.dump`, never through this disk, and writes
the URI to the release directory's `database-dump` file. Taken with every writer stopped, it is
exactly the state the migration starts from. pg_dump's exit status is the proof the dump is whole
(pipefail); a failed dump or upload removes the partial object and restarts the containers the
deploy stopped, exactly as they were (`docker start` on their ids, no image or configuration
decision), with nothing migrated. A failed migration or an unhealthy new release is **not**
rolled back: the schema may have changed, so the script leaves the applications stopped and prints
the dump's URI, and `docs/deployment.md`, "Restoring the database before a release", is the way
back. `on_exit` reads `phase` (`preflight`, `stopping`, `migrating`, `starting`, `web`, `live`) to
tell those apart; a new step between the stop and `migrate` belongs to `stopping`. The instance role
already writes the bucket; `storage.tf`'s `expire-database-dumps` rule expires the prefix after 30
days. CI's smoke test (`check-production-docker.sh`) restores a dump with the same flags into a
scratch database on every release, so the restore is rehearsed against the real schema.

**The worker's healthcheck counts only its own container's heartbeat, because a lane's key outlives the worker that wrote it.**
The compose healthcheck was a `node -e` that imported bullmq and asked each queue for consumers:
about 0.55 s of CPU and 76 MB every 15 s, some 8% of a t3 vCPU. `worker-healthcheck.sh` asks
Redis over bash's `/dev/tcp` for every lane's heartbeat key (`packages/core/src/workerHeartbeat.ts`;
five since the background lane, 2026-10-17, which is listed although `/api/ready` leaves it out) and passes only if each was last written by
this container's hostname, which the worker records
as `os.hostname()` and Docker changes with every recreate. The host test is the point: a key lives
90 s after its worker stops, and the new worker often starts sooner than that after the old one
drained, so without it `up --wait` passed on the old worker's beat. It also sees a wedged event
loop, which BullMQ's consumer list never could. It reads `REDIS_URL` and understands only
`redis://host[:port]`; a password or TLS needs AUTH and TLS added to it first. The queue names
are copied from `jobLanes.ts`, and `test_worker_healthcheck.py` fails if they drift — a lane added
to `GENERATION_JOB_QUEUES` without a key here is a worker reported healthy with a lane nothing
consumes.

**A deleted or overwritten object stays recoverable for 30 days, and no longer.** The assets
bucket had no versioning, and books are promised forever, so one wrong `deletePrefix` lost them for
good. `storage.tf` turns versioning on: a delete or an overwrite leaves a noncurrent version that
`expire-noncurrent-versions` removes after 30 days (and the delete marker after it), so the app's
deletes (a book, an account, retention sweeps) still remove data, a month later rather than at
once. Database dumps keep their expired version one day. That is what the privacy text may promise:
deleted files persist up to ~30 days in versions, dumps ~31, EBS snapshots 14 (`backups.tf`), plus
the day or so AWS takes to run a lifecycle action. A noncurrent version is restored with
`aws s3api list-object-versions` and a copy of that version over the key. `putIfAbsent`'s
`If-None-Match` still works: a delete marker counts as absent.

## Process entry points

`start-production.sh`, `docker-dev-entrypoint.sh` and `tsx-dev.mjs` are part of the Chromium
shutdown story, not just launchers. All three must forward or trap **SIGHUP** alongside INT/TERM:
puppeteer's own handlers are off, so a hangup that Node does not handle never reaches its
`process.on("exit")` net and leaves a Chromium reparented to init. `tsx-dev.mjs` forwards a hangup
as **SIGTERM**, because nodemon handles that and not `SIGHUP` — sent verbatim it dies and orphans
the app holding the browser. See `packages/core/src/generation/CLAUDE.md`.

`docker-dev-entrypoint.sh` sets `umask 0000` so the host user can write into directories the
container created first. Durable application bytes are in S3; bind-mounted files are development
artifacts and scratch only.
