# Fast decisions

Quality → Model routing → **Fast decisions** optionally selects page drafts,
chapter drafts, and catalog covers through `DecisionModelAdapter.choose`.
Leave it on **Use existing judgment routes** to retain the original calls.
Chapter candidate count remains one; this route does not enable more drafting.
Text judgments, writing, creation chat, summaries, and critiques are unchanged.

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
Lower probabilities, invalid distributions or choices, missing credentials, and
provider errors use the configured LLM fallback stage. This policy is defined in
`DECISION_MIN_WINNING_PROBABILITY`; it is an initial operating threshold, not an
accuracy guarantee or TypeSafe's separate confidence statistic. Each provider has
bounded network retries, with SDK retries disabled. Cancellation escapes without
fallback. Settings read failures are visible and cannot switch to compiled defaults.

The route is resolved once per logical selection, including both chapter orders.
Each attempt gets a run-log `decision.choose.attempt` event and one provider-cost
row, including an uncertain Jev call followed by an LLM call. Events retain usage,
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

References: [Vercel announcement](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway),
[evaluation result interface](https://github.com/vercel/ai/blob/main/packages/ai/src/evaluate/evaluation-result.ts),
[TypeSafe model pricing](https://docs.typesafe.ai/models).
