# Fast decisions

Quality → Model routing → **Fast decisions** optionally selects page drafts,
chapter drafts, and catalog covers, screens style audits, and confirms Smart Unslop candidates through
`DecisionModelAdapter.choose`.
Leave it on **Use existing judgment routes** to retain the original calls.
Chapter candidate count remains one; this route does not enable more drafting.
Other text judgments, writing, creation chat, summaries, and critiques are unchanged.

Set `VERCEL_AI_GATEWAY_API_KEY` in the API and worker environments, restart them,
then select **Jev · TypeSafe** and an available **Fast decisions fallback** LLM.
The initial fallback derives from Fast judgments. Saving the new primary pins
that fallback in the Quality revision JSON. Removing credentials preserves the
saved selection and shows it as unavailable; provider failures escalate at runtime.
No migration or customer credit price change is needed. Model reset disables
Fast decisions; resetting quality gates preserves model settings.

The Jev adapter uses `typesafe-ai/jev` through the Gateway evaluation API with
`ai@7.0.105` and `@ai-sdk/gateway@4.0.85`. Its experimental API is isolated in
`packages/core/src/adapters/jevDecision.ts`. It supplies a choice and probabilities,
not a written rationale. LLM choices use the same instructions, candidates, and
source evidence. Large inputs are sent intact; context-limit errors escalate.

A valid winning-option probability of at least **0.70** accepts Jev's answer.
On page, chapter, and cover selection — screens that do not set
`escalationPolicy: caller` — lower probabilities, invalid distributions or
choices, missing credentials, and provider errors use the configured LLM
fallback stage. Confirm-smart-unslop uses caller escalation instead; see
[Smart Unslop confirmation](#smart-unslop-confirmation). This policy is defined in
`DECISION_MIN_WINNING_PROBABILITY`; it is an initial operating threshold, not an
accuracy guarantee or TypeSafe's separate confidence statistic. Each provider has
bounded network retries, with SDK retries disabled. Cancellation escapes without
fallback. Settings read failures are visible and cannot switch to compiled defaults.

The route is resolved once per logical selection, including both chapter orders.
Each attempt gets a run-log `decision.choose.attempt` event and one provider-cost
row, including — on page, chapter, and cover selection — an uncertain Jev call
followed by an LLM call. Events retain usage,
latency, probabilities, choice, and escalation reason. Failed calls with no usage
remain unpriced. Jev costs $0.042 per million input tokens and zero for output;
the existing provider-cost table owns that rate.

Run the synthetic English/Persian comparison locally:

```sh
pnpm decisions:compare          # deterministic, no network
pnpm decisions:compare --live   # paid Jev + configured Fast judgments baseline
```

The JSON report includes raw Jev/LLM agreement, final-route agreement, escalation
rate, per-attempt latency and usage, known provider cost, and unpriced calls.
The baseline uses compiled Fast judgments from the local environment, without
reading or changing production settings. Review the fixture texts and outcomes;
agreement with one LLM alone does not establish quality. Activation remains a
manual Quality-settings change after review.

Live smoke check on 2026-09-17: all six fixtures completed through the LLM
fallback. Gateway returned Jev provider errors followed by a free-tier 429.
No usable Jev answers were obtained, so Jev/LLM agreement remains unmeasured.
The mock harness and automated tests do not establish real-model quality.

## Style audit screening

When `styleAuditor` is enabled, pinned excerpts exist, and Jev routing is available,
`screen-page-style` judges the same complete figure-free page, pinned excerpts,
voice guide, local anti-AI rules, and explicit reader edit request as the diagnostic
auditor. Reader-requested tone, register, pacing, and mood changes are intentional;
both paths judge only unintended drift and contextual defects.

Only `clean` with a valid winning probability of at least 0.70 returns the existing
empty successful audit. `defect`, `insufficient_context`, malformed or low-probability
answers, unavailable routing, and failed decisions go directly to `audit-page-style`
for actionable `styleIssues`. Like Smart Unslop, this uses caller-managed escalation,
so no generic LLM choice is bought before diagnosis. The shared screen transport owns
validation, escalation, cancellation, and logging; each gate retains its own rubric
and pass choice. Existing bounded provider retries and per-call accounting remain.

The report still records an audited pass as `stylePenalty: 0`, keeps penalties
separate from reviewer scores, and compares audited/unaudited candidates as before.
The page loop still spends at most two revision audit attempts per page: clean
screens, escalated diagnoses, and failed attempts all consume that same budget.
Initial enrichment remains separate. Cancellation propagates without diagnosis.

`decision.gate.outcome` records `style-audit-screen-v1`, page index, choice,
probabilities, escalation reason, and `auditAvoided`. This flag counts a skipped
diagnostic style audit, not an avoided ordinary page review or measured net savings.
Logging failures do not change the verdict. Focused tests verify orchestration with
controlled decisions; real-model defect misses, unnecessary escalations, multilingual
quality, latency, and cost remain unevaluated. The 0.70 threshold is initial routing
policy, not calibrated style accuracy. No live routing setting is changed here;
evaluate saved drafts and revisions, including requested tone changes, before rollout.

## Smart Unslop confirmation

When Smart Unslop finds a significant cluster and Jev routing is enabled,
`confirm-smart-unslop` supplies the full draft, every flagged span (with offsets
in the normalized scanner prose), book/genre and local style guidance, pinned
style excerpts, and any explicit reader edit request. It protects quotations,
technical language, intentional repetition, and essential qualifications.

Only `legitimate_use` with a valid winning probability of at least 0.70 removes
the Smart Unslop rewrite request. Ordinary review and independent local or
mandatory failures still apply. `contextual_defect`, `needs_review`, malformed or
low-probability answers, unavailable routing, and provider failures retain the
existing conditional rewrite, including its permission to return an unchanged
page. This screen uses `escalationPolicy: caller`: bounded Jev network retries
still run and are accounted for, but escalation goes directly to that existing
rewrite instead of buying another finite-choice LLM decision. Cancellation
escapes without escalation.

A clear legitimate decision or an attempted conditional rewrite spends the
page loop's one-shot Smart Unslop opportunity. Other quality repairs keep their
existing budgets. Physical calls retain `decision.choose.attempt` events and
cost rows; `decision.gate.outcome` separately records the question version,
choice, probabilities, escalation, and `rewriteAvoided`. That flag describes
removal of the Smart Unslop rewrite request; it does not claim that an unrelated
repair was avoided or establish measured cost savings. Logging failures do not
alter generation.

The focused tests use controlled decisions to verify orchestration. Jev's
accuracy on these prose distinctions, false acceptance rate, multilingual
coverage, and end-to-end latency/cost savings remain unmeasured. The 0.70
threshold is reused routing policy, not calibrated accuracy. No live routing
setting is enabled by this implementation.

References: [Vercel announcement](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway),
[evaluation result interface](https://github.com/vercel/ai/blob/main/packages/ai/src/evaluate/evaluation-result.ts),
[TypeSafe model pricing](https://docs.typesafe.ai/models).
