# Live 30-page storybook acceptance

This operator harness runs one to three matched rounds of Quick (`fast`), Balanced
and Premium using the same saved character portraits and input. It does not reserve
credits, unlock exports, or purchase subscriptions. Billing and entitlement
checks remain in the API and database test suites.

## Prepare

Run inside the local API container so object storage credentials and the MinIO
endpoint match the stack. A baseline is the saved manifest array from the
original operator test; each entry includes `projectId` and `input`. The source
project must still exist to establish its owner. The selected Rabbit and Wise
Turtle portraits must resolve in MinIO.

```sh
docker compose exec -T api pnpm exec tsx scripts/storybook-acceptance.ts prepare \
  --baseline .scratch/character-story-30-2026-09-23/manifest.json \
  --rounds 1 --max-minutes fast=5,balanced=8,premium=12 \
  --illustration-cadence every-third-page \
  --out .scratch/storybook-performance-2026-09-23
```

Preparation validates the exact 30-page illustrated input and portrait bytes,
then allocates three runs per selected round. `--rounds 1` is the initial optimization
experiment; use a fresh directory for each implementation. The example's 5/8/12-minute
ceilings are provisional engineering targets, not product SLOs. Supply all three
explicitly; there are no default performance ceilings. Preparation makes no provider
calls and creates no generation jobs.

For the 30-page text-only benchmark, use `--illustration-cadence none
--benchmark-profile text-only-30` instead of `--max-minutes`. This freezes
provisional 5/8/12-minute targets for Quick/Balanced/Premium. Custom targets remain
explicit inputs. The separate four-hour observer watchdog is never a performance
target: new targets must be shorter, and old 240-minute captures report performance
as unassessed. Capturing an old run does not rewrite its saved manifest.

`--illustration-cadence every-third-page` selects exactly ten interior illustrations
on story pages 3, 6, 9, …, 30. All 30 story pages still contain prose; the other
20 pages contain text without scene illustrations. Covers and the two saved
portrait references are counted separately. `every-page` selects all 30 pages;
omitting the option (`baseline`) preserves the source input. The explicit sparse
option minimally adjusts the brief's scene wording and appends the exact count
and indexes. Manifest version 3 records the original and prepared prompts, cadence,
expected indexes, and input fingerprints. This is a changed user input: comparisons
with fully illustrated retained samples cannot isolate code performance effects.
New manifests use version 4 and also freeze `pdfLayoutPolicy`: exactly 30 distinct
physical story sheets in reading order, with each logical scene occupying one
measured page. Cover, contents, and any back matter are additional measured pages;
the total is not assumed to be 32.

`preflight --out <same directory>` checks worker, queue and portraits without
launching jobs. Two audited June local database rows are tolerated only when
still older than seven days and freshly absent from Redis; the report names
them. The harness never edits those historical rows.

## Launch after integration checks

Drain current jobs and run the focused regression suites and `pnpm check` first.
Confirm the sole worker is the intended real-provider worker. Do not run a host
worker alongside Docker; they consume the same queue. Keep source files and
Quality settings unchanged until the matrix ends.

```sh
docker compose exec -T api pnpm exec tsx scripts/storybook-acceptance.ts launch \
  --out .scratch/storybook-performance-2026-09-23
```

Launch requires local MinIO, `MOCK_AI=false`, exactly one queue worker, and no
unrelated open jobs. It freezes source hashes, Git revision and patch, untracked
source, Quality revision, resolved stage routes, concurrency and portrait hashes.
It runs one matched tier round at a time. Let every sample in that round finish;
exceeding a performance ceiling records a failure after completion and never cancels
a healthy generation. A failed or unassessed automated acceptance result prevents subsequent rounds.
Failures do not trigger generation retries or replacement samples.

If the observer process is interrupted, `watch --out <same directory>` resumes
observation and normal plan approval. It does not retry failed jobs. Predetermined
project IDs and queue dedupe keys prevent a repeated launch during crash recovery
from creating an extra book. Use only one observer per manifest.

`capture --out <same directory>` rereads existing work and downloads. It can be
repeated independently after a capture failure and never generates or repairs.

## Results

Each run saves the manuscript, database rows, provider run logs, downloaded PDF,
EPUB and DOCX, provenance sidecars and `summary.json`. The matrix stores its own
summary and live `status.json`. Missing usage cost is counted separately from
known cost hints; the latter is not an invoice.

`publicationPassed` reports delivery; `functionalPassed` adds unattended execution
and artifact integrity. `qualityPassed` reports remaining automated findings and
failed page QA. `semanticPassed` requires a complete assessed inventory with every
requirement fulfilled. Missing review data is unknown, never a pass. The full
`quality` and `semantic` objects retain residual issues, missing requirements and
unverified requirements independently of delivery.

`performance.passed` reports the selected tier's experimental elapsed-time target;
absent limits and legacy watchdog-only limits produce `not_configured`, never a
performance pass. `automatedPassed` requires functional, quality, semantic and
performance checks all to pass. Round advancement and the command exit status use
this automated result. Overall `passed` stays false while human review is pending;
`acceptanceStatus` distinguishes `human_review_pending`, `failed`, `unassessed`, and
an incomplete matrix. A completed capture is not an editorial approval. Matrix
completion still uses the prepared run count, so one matched round is three samples.

Quality scores indicate unresolved findings, not literary merit. New reports group
exactly linked diagnoses, guidance, page status and repair history once, retaining
all original messages in the saved report. Historical reports keep their original
scores and interpretations.

Performance evidence includes planning, manuscript, illustration, and finalization
timings; non-image recorded calls; physical text attempts, retry ordinals, recorded
errors and truncations; reasoning tokens; and the slowest purposes with effective
output limits. Stage spans overlap and are not additive. `activeMs` unions concurrent
job intervals; `summedJobMs` counts their work separately. Wire-event telemetry is
distinguished from recorded call rows and unknown SDK-internal image retries.

`loggedErrors` counts raw error events; `ledgerKnownFailedTextCalls` also exposes
failures absent from those events. `textAttemptsWithoutUsage` counts physical
attempts without any usage snapshot, independently of missing reasoning fields.
`tokenAccounting` separates provider-reported and estimated counts.
`costAccounting` reports the known subtotal and unknown-price call count. Their
`complete` flags require all text ledger rows to match physical attempts without
ambiguity, with confirmed tokens or settled prices respectively. Missing traces,
in-flight rows and unpriced calls cannot establish a complete run total.

A functional pass requires:

- Publication without failed/canceled jobs or a restarted plan/book.
- Exactly 30 nonempty saved story pages. Pages retained after exhausted quality
  repair are allowed only with an explicit `review_recommended` report.
- For illustrated books, both character references seeded from the selected saved
  portraits, exactly one scene asset on each configured illustration page, no
  scene assets on text-only pages, and exactly two portrait-reference assets.
  Text-only books require zero image assets and zero image-provider calls.
- One durable finalization operation and no text QA restart on an image handoff.
- All three downloads with matching byte digests and current revision.
- A readable PDF and page map covering every story page, plus CRC-valid archives
  with readable DOCX document content and EPUB reading-order content.
- For version 4, exactly 30 ordered, disjoint, single-page story ranges. Collapsed
  scenes sharing a physical page and scenes split across pages fail this contract.

PDF physical pages are recorded separately: cover and contents do not count as
story pages. Human review remains explicitly pending for character likeness (when illustrated),
chapter transitions, both character arcs and rendered layouts. A small pilot
provides comparison evidence, not a production reliability estimate.
For sparse books, PDF capture records the ten illustrated and twenty text-only
story-page indexes covered by the current page map; all 30 must have valid physical
ranges. Physical page count is read from the PDF, never inferred from illustration
count. These map checks do not substitute for visually reviewing all rendered
pages. EPUB/DOCX integrity and revision/digest checks are the same for both cadences.
Older captures retain their original recorded measurements and policy. In particular,
30 logical story records mapped into 15 physical pages passed the older map-presence
check; that does not pass the version 4 layout contract. Record any stronger reassessment
separately instead of rewriting the historical summary.

Relevant offline commands:

```sh
node --test scripts/generation-acceptance.test.mjs
pnpm -F @book-maker/api exec vitest run src/mobile/generationProgress.test.ts src/mobile/finalizationProgress.test.ts src/mobile/plans.test.ts src/mobile/plansResume.test.ts src/mobile/accessAndExports.test.ts
pnpm -F @book-maker/db exec vitest run src/generationAttempts.test.ts src/billing.test.ts
```
