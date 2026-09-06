# Initial plan loses authored chapters

Observed in candidate 4, project `cmtp66oa20000cbg0rtrjww2o`. The generation was stopped with no page rows before any compose-chapter call. This is an implementation failure found while inspecting the fresh plan; it has no whole-book literary score.

## Reproduction

`pnpm exec tsx docs/composed-chapters/experiments/2026-09-05-whole-book/replay-plan-4.ts`

The command reads the saved raw provider JSON, calls the actual `bookPlanModelOutputSchemaWithFallback`, and asserts that every authored chapter survives. Before the fix it fails with generic fallback beats such as “Advance one clear idea, conflict, or discovery” replacing named historical investigations. The input/output artifacts and red log are retained.

The minimal failure is a top-level plan record whose `authorStance` has valid stance fields plus a misplaced `chapters` array. Initial normalization merges the generic fallback, then normalizes stance and strips its unknown fields. No error reaches the existing JSON repair path because the fallback already supplies a valid chapter array.

## Cause localization

Three candidate boundaries distinguish the failure: (1) normalization loses the chapters; (2) the model never supplied a real outline; (3) the critic corrupts a previously valid outline. The saved raw response contains fourteen historical chapters under `authorStance`, refuting (2). The adapter's parsed `data` already contains the generic fallback before either critic response, refuting (3) as the origin. Replaying normalization alone reproduces (1). Because the actual raw and parsed response expose this boundary directly, further bisection and speculative instrumentation are unnecessary. The critic's merges amplify the damage but are not the first cause.

## Repair contract

Only initial planning recovers known missing root plan fields from the recognized stance object. Existing root fields take precedence, even when empty or malformed, so recovery cannot silently replace explicit bad output. The recovered fields pass ordinary schema validation; unknown fields stay excluded. Initial planning requires a nonempty authored chapter array, allowing the existing bounded repair path to handle an omission. Partial plan revisions retain their current fallback behavior. Server-owned research remains outside the model result. The initial prompt also explicitly places `chapters` beside `authorStance`.

Verification requires the original unmodified response to preserve all fourteen chapters, small regression cases covering precedence/wrappers/missing fields/revision compatibility, and the complete repository check. No paid chapter experiment is needed for this parser bug.
