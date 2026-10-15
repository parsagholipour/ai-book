# DeepSeek provider comparison — 6 October 2026

The cheaper third-party endpoints are real alternatives, but the lowest token price does not establish equivalent behavior or the lowest cost per finished book. Trial inference.net with a pinned provider and direct DeepSeek fallback; test Decart separately for its lower output price. Morph's current availability snapshot and tool-choice limits make it a less attractive initial production choice. This is primary-source research and repository inspection, not a live generation benchmark. No paid inference requests or application changes were made.

## Compare the current model and price card

DeepSeek's current changelog says `deepseek-v4-flash` temporarily routes to **V4.1 Flash**, and the current name is `deepseek-flash`. It also explicitly retains V4 Pro after September 14, despite the original release announcement's retirement plan. Comparing the linked Flash model with our Pro configuration changes models as well as providers. Prefer the updated changelog and pricing documentation over the earlier announcement. [DeepSeek changelog](https://api-docs.deepseek.com/updates/)

| First-party Flash rate, USD / million tokens | Uncached input | Output | Cache read |
| --- | ---: | ---: | ---: |
| Current published off-peak | 0.15 | 0.60 | 0.003 |
| Current published peak | 0.30 | 1.20 | 0.006 |
| Repository's August 16 card, off-peak | 0.22 | 0.66 | 0.007 |
| Repository's August 16 card, peak | 0.44 | 1.32 | 0.014 |

The repository's Flash cost estimates are stale relative to September's reduction. These are application accounting estimates, not evidence that DeepSeek still charges those amounts. Pro remains $0.66/$1.98/$0.022 off-peak and $1.32/$3.96/$0.044 peak. Sources: [current DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [repository rate table](../packages/core/src/textCostRates.ts), and the DeepSeek endpoint's scheduled pricing overrides in the [public OpenRouter endpoints API](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints).

## Endpoint snapshot

All prices below are USD per million tokens, before platform fees and tax. Prices and availability are snapshots, not guarantees. Morph's input price changed from $0.023 to $0.053 during this investigation; the table uses the later value, which also matched the provider page. The API uses the name `InferenceNet` for inference.net.

| Provider / endpoint tag | Input | Output | Cache read | Precision label | 24-hour uptime snapshot | Forced tool choice: required / named function |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Morph / `morph/fp8` | 0.053 | 0.284 | 0.008 | FP8 | 91.38% | No / No |
| inference.net / `inference-net` | 0.070 | 0.300 | 0.018 | Unknown | 99.46% | Yes / Yes |
| Sail Research / `sail-research/fp4` | 0.080 | 0.400 | 0.010 | FP4 | 98.76% | Yes / Yes |
| Decart / `decart/fp4` | 0.090 | 0.180 | 0.018 | FP4 | 96.86% | Yes / No |
| DeepSeek / `deepseek`, off-peak | 0.150 | 0.600 | 0.003 | Unknown | 99.99% | No / No |
| Relace / `relace` | 0.003 | 2.400 | 0.003 | Unknown | 99.94% | No / No |

Source: [OpenRouter public endpoints API](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), checked October 6, 2026. Its `uptime_last_1d` differs from the website's displayed time window. These observations do not establish an SLA. Relace illustrates why the smallest input price alone can mislead an output-heavy writing workload. Context and completion caps also differ: inference.net has a 1,040,000-token context and 384,000 completion cap; Decart's completion cap is 262,144; Morph's is 943,718.

## What the catches actually are

**Inference behavior and quality need measurement.** The same named model can behave differently because of kernels, numerical precision, chat templates and tool parsers. An FP4 label alone does not prove reduced quality: DeepSeek's published configuration already uses an FP8 quantization method with FP4 experts. “Unknown” does not establish full precision. OpenRouter reports that parser differences, rather than quantization alone, often explain tool-call variance. Its general observations do not establish equivalent Persian or English book quality for these endpoints. [DeepSeek model configuration](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/raw/main/config.json), [OpenRouter provider variance findings](https://openrouter.ai/blog/announcements/auto-exacto/)

**Routing can alter both the bill and behavior.** Without restrictions, requests can use another provider. Unsupported request parameters may be ignored unless `require_parameters: true` is set. Use an explicit `only`/endpoint allowlist and `max_price` to bound provider selection and fallback prices; verify detailed tool-choice support separately. Narrow filters reduce fallback options. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

**Cheap output is not the whole bill.** Reasoning tokens are billed as output, including when hidden. On most providers they share the completion budget with visible prose; too small a budget can produce an empty answer after consuming billable reasoning. The current [OpenRouter adapter](../packages/core/src/adapters/openrouter.ts) always enables reasoning and turns `thinkingEnabled: false` into low effort, so simply changing the model would not preserve our direct DeepSeek non-thinking behavior. [OpenRouter reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

**Caching can favor direct DeepSeek.** Each shortlisted third party has a higher cache-read rate than direct Flash off-peak. For an illustrative request with one million fully cached input tokens and 10,000 total output tokens, direct Flash costs $0.009, whereas Morph costs $0.01084 before platform fees. This is arithmetic from the endpoint prices, not a measured request. Cache-hit rate, input/output mix, thinking and retries decide the actual savings. Caches are provider-specific; OpenRouter's sticky routing helps, but automatic failover and Auto Exacto's provider reordering can introduce misses. [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto)

**There is a platform fee.** OpenRouter passes through inference prices, but Standard has a 5.5% platform fee; Business has 8%. Enterprise alone lists contractual SLAs. The fee reduces the price advantage without explaining away the large output-rate gap. [OpenRouter pricing](https://openrouter.ai/pricing), [billing FAQ](https://openrouter.ai/docs/faq)

**Privacy depends on the endpoint agreement.** OpenRouter lists all four shortlisted providers as no-training/zero-retention, and stores prompt contents only when opted in. General provider policies can differ: Morph's October 5 policy describes 90-day PAYG/free retention, 30-day paid retention and training exceptions for support/debugging, with true ZDR at enterprise. Sail's general terms permit stored responses. This discrepancy does not prove OpenRouter traffic is retained: OpenRouter documents that endpoint-specific agreements can provide stricter terms. Enforce `provider.zdr: true` and verify applicable endpoint terms before relying on a retention promise for unpublished manuscripts. [Provider directory](https://openrouter.ai/providers), [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [endpoint-specific ZDR policy](https://openrouter.ai/docs/guides/features/zdr), [Morph privacy](https://www.morphllm.com/privacy), [Sail terms, section 3.3](https://www.sailresearch.com/terms)

## Measured caching in local call logs

Read-only queries of the local development PostgreSQL database on October 6 found **18.50% of DeepSeek input tokens cached**: 5,193,472 cached tokens / 28,075,562 input tokens, across 5,315 calls. This is token-weighted, not an average of call percentages. All rows have a cache counter; none has an invalid counter or is marked estimated/provisional. Restricting to the 5,076 explicitly settled rows gives 18.46%; the other 239 are legacy rows without settlement metadata. 60.49% of calls had at least one cached token.

| Logged model | Calls | Input tokens | Cached input tokens | Cached share |
| --- | ---: | ---: | ---: | ---: |
| V4 Flash | 3,207 | 14,621,109 | 2,517,504 | 17.22% |
| V4 Pro | 2,033 | 12,893,901 | 2,604,032 | 20.20% |
| V4 Flash Vision Exp | 75 | 560,552 | 71,936 | 12.83% |

**Scope limitation:** these are local historical calls, predominantly before V4.1. Since September 10 there are only three direct DeepSeek calls (7,668 input tokens, zero cache hits), all on September 19; there are none since September 29. Current local traffic mainly uses other providers. This database cannot establish the current production or representative V4.1 cache-hit rate.

Historical page reviews hit 29.75% cached input, page revisions 29.42%, and story-state extraction 4.15%. Forty chapter-composition calls and 31 chapter-edit calls on September 2 had zero cached input; they predate the current prompt implementation and V4.1, so they are not a benchmark of today's chapter pipeline.

The [DeepSeek adapter](../packages/core/src/adapters/deepseek.ts) maps the response's `prompt_cache_hit_tokens` into usage, and the [worker recorder](../apps/worker/src/providers/usageAccounting.ts) and [API recorder](../apps/api/src/inlineProviderUsage.ts) persist it. Caching is automatic and prefix-based. [DeepSeek caching guide](https://api-docs.deepseek.com/guides/kv_cache/)

Current [chapter requests](../packages/core/src/generation/composedChapter.ts) send a system message and a JSON user payload. Some stable rules lead, but chapter-specific text appears within the system message; `stanceLinesFor` can also insert chapter-specific arc text early. That divergence prevents the later shared user-payload text from extending the cross-chapter cache prefix. Moving stable material before variable material is an optimization candidate, not proof of a particular hit rate.

Repricing the historical Flash token mix at the October 6 rates, assuming identical output and cache counts, gives $2.815 direct off-peak, $1.465 through inference.net and $1.511 through Decart, including OpenRouter's 5.5% Standard fee for the latter two: 47.96% and 46.32% less respectively. These are illustrative rate-card calculations, not historical invoices or measured alternative-provider bills. The measured cache share does not reverse their price advantage under those assumptions.

Reproducible queries and aggregate results: `.scratch/deepseek-cache-audit-2026-10-06/audit.sql` and `audit.json`. The database container was returned to its initially stopped state.

## Practical next step

Correct the Flash accounting card, then run the same representative chapter-writing, JSON planning and tool-call tasks through direct V4.1 Flash, pinned inference.net and pinned Decart. Preserve thinking mode and effort; include Persian and English, long prefixes and cache reuse. Compare accepted text quality, schema/tool failures, retry rate, p50/p95 latency and total cost including reasoning, cache misses and fees. Keep first-party fallback during the trial, with its own explicit cost allowance. This recommendation is an inference from published capabilities and availability; no provider has yet been validated on our workload.
