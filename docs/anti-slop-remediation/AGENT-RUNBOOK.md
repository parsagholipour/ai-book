# Anti-Slop Remediation Agent Runbook

Use this runbook for every phase in this folder. It exists to keep the phases cumulative, preserve generation invariants, and prevent later work from reinterpreting earlier interfaces.

## Before Editing

1. Read the root `CLAUDE.md`.
2. Read the `CLAUDE.md` in every package or worker directory the phase will touch.
3. Read this runbook, the folder README, the current phase, and all earlier output notes.
4. Inspect `git status --short` and preserve unrelated user changes.
5. Re-run the smallest relevant baseline tests before changing behavior.
6. Confirm that every prerequisite phase acceptance criterion still holds.

If prior-phase behavior is absent or has regressed, repair that behavior within the current phase only when the fix is small and necessary. Otherwise stop and document the prerequisite failure.

## Implementation Discipline

- Keep `packages/core` free of database, queue, HTTP, and worker imports.
- Keep provider calls behind the existing text-model adapter seam.
- Prefer pure functions for parsing, detection, candidate selection, and grading inputs.
- Keep retries, job progress, persistence, and publication fencing in the worker.
- Test through the module interface. Do not expose internal tokenizers, scorers, or normalization helpers only to make tests convenient.
- Replace obsolete shallow tests when a deeper interface makes them redundant; do not layer brittle implementation tests indefinitely.
- Preserve stop-request propagation. A quality pass may degrade only where the phase explicitly permits degradation.
- Preserve the invariant that a repaired chapter brief becomes durable only when a page keeps a draft written from it.
- Preserve edit ownership, content revision, and export stand-down behavior.
- Do not add an unmetered model call. Every new call needs a purpose, a bound, logging, usage accounting, and a clean-path no-call test.

## Correctness Versus Polish

Treat these as mandatory correctness:

- Response schema validation
- Exact page coverage and ordering
- Generic assignment rejection
- Full-map collision detection
- Deterministic manuscript checks
- Quality-state enforcement

Treat these as configurable polish unless a phase explicitly promotes them:

- General model page review
- Best-of drafting or polishing
- Style comparison against excerpts
- Writer tools
- Broad model plan criticism

Never make a mandatory invariant conditional on `GenerationQualityRevision`. Temporary shadow or rollout switches must be named as rollout controls and removed or defaulted on after Phase 05.

## Test Loop

During implementation, prefer focused commands:

```bash
pnpm -F @book-maker/core exec vitest run src/generation/<target>.test.ts
pnpm -F @book-maker/worker exec vitest run src/generation/<target>.test.ts
pnpm -F @book-maker/worker exec vitest run src/handlers/<target>.test.ts
pnpm -F @book-maker/core typecheck
pnpm -F @book-maker/worker typecheck
```

Before completing a phase:

```bash
pnpm check
```

If a command cannot run, record the exact reason and the narrower verification that did run. Do not report unrun validation as passing.

## Fixture Rules

- Commit distilled fixtures that demonstrate one behavior clearly.
- Do not commit full generated books merely to test a four-page repetition cluster.
- Keep an optional local replay path for complete manuscripts.
- Include positive controls that look superficially similar but should remain clean.
- Include imported-manuscript and non-English controls where the changed detector could affect them.
- Never make test fixtures depend on mutable provider logs under `storage/`.

## Observability Rules

New integrity and review behavior must produce structured evidence suitable for run logs and quality reports:

- Detector or contract version
- Phase of generation
- Finding code
- Affected pages and chapters
- Counts, ratios, and cluster size where applicable
- Repair attempt and batch number
- Whether the path retried, regenerated, degraded, blocked, or completed

Do not log secrets, credentials, full private prompts, or entire manuscripts as metric fields. Existing provider run logs remain the detailed debugging artifact.

## Phase Completion Checklist

- All implementation tasks are complete or explicitly deferred with a reason.
- Acceptance criteria are demonstrated by tests or recorded manual evidence.
- Focused tests pass.
- `pnpm check` passes, or unrelated/pre-existing failures are identified precisely.
- New model calls have accounting and clean-path no-call coverage.
- No unrelated user changes were overwritten.
- Phase output notes exist.
- The next phase's prerequisites are stated accurately.

## Output Notes Template

Create `phase-NN-output-notes.md` with:

```markdown
# Phase NN Output Notes

## Status

Complete | Partial | Blocked

## Implemented

- Observable behavior and interface changes.

## Files Changed

- Paths grouped by module.

## Tests Run

- Command and result.

## Metrics Or Replay Results

- Baseline and new result.

## Deviations From Plan

- What changed and why.

## Known Risks

- Remaining uncertainty or rollout concern.

## Handoff To Next Phase

- Exact prerequisites, flags, and decisions the next phase inherits.
```

## Stop Conditions

Stop and request direction when:

- A proposed change requires retroactively modifying existing user books.
- A blocker would prevent artifact access rather than only prevent completion.
- A new model call cannot be bounded or attributed for cost accounting.
- Precision cannot distinguish legitimate recurring subject matter from duplicate treatment.
- Required schema or status changes would break an external mobile or operator contract without a migration path.
