# Controlled story-allocation experiment

This diagnostic changes the supplied map while keeping the current whole-book
writer and Premium's captured plan/settings fixed. It never publishes to a
project, changes Quality settings, or generates images.

From the repository root, choose a **new** output directory:

```sh
pnpm exec tsx scripts/story-allocation-run.ts prepare .scratch/allocation-new-run
node --test scripts/story-allocation-experiment.test.mjs
pnpm exec tsx scripts/story-allocation-run.ts oracle .scratch/allocation-new-run
```

`prepare` makes no provider calls. It requires the September 26 22:14 captures
under `.scratch/storybook-text-only-2026-09-26-2214/` and
`.scratch/three-tier-flow-audit-2026-09-26-2214/`. It freezes the exact input, plan,
original final map, editorial map, writer messages including JSON contract,
source hashes, primary route, rubric, and counterbalanced sample order.

`oracle` makes four paid logical draft calls. It uses the captured primary route,
the production writer's JSON/output recovery, no SDK transport retries, sequential
samples, and a ten-minute watchdog per physical attempt. These controlled adapter
settings are identical in both arms; this is not a full production-router test.
Every attempt is recorded immediately. Failed samples stay in the matrix, and
unknown usage is never treated as a zero-cost attempt. Reasoning is already part
of output tokens and is not added twice.

The runner refuses changed source or initial messages. Exclusive sample
directories prevent a repeated launch from buying duplicate samples. After an
interruption, inspect the process and saved results first. An unfinished sample
with no usage is unresolved; do not relaunch it under another label or infer a
provider refund. A fresh experiment is a new measured matrix.

Read each `book.md` against `rubric.json` without opening `oracle-manifest.json`,
then save page-cited judgments before revealing variant labels. Content may reveal
which map was used; an agent reading its own editorial map is not an independent
human assessment. `oracleComparisonReadiness` checks matrix completeness, not
literary merit. Both revised-map drafts must improve the targeted problems with
no new causal contradictions before advancing.

The `mapExperimentRequest` helper isolates the proposed variable beat-length
instruction without a production flag or schema change. It fails on prompt drift
instead of silently testing the wrong variant. Do not dispatch its 12-map matrix
or the held-out full-generation matrix until the oracle gate passes. Total
generation tokens, including review and repair, remain the promotion criterion.

The September 27 run stopped at the oracle gate. See
[the measured report](../output/story-allocation-controlled-2026-09-27.md).
