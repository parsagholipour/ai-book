# Research timing breakdown — 23 September 2026

P3-03 from the twenty-page audit is implemented for subsequent Gemini research calls. Each successful `ResearchResult` includes optional `timings`; the existing worker logger preserves this object under `result.timings` in its immutable `research.search.response` event, correlated with the request's `callId`, project, and generation job. Custom research adapters can omit it.

| Field | Measures |
| --- | --- |
| `providerRequestMs` | Elapsed time awaiting the provider SDK call, including provider-managed search and any SDK retries. |
| `groundingRedirectsMs` | Wall time for the complete redirect-resolution batch, including failed resolutions. Concurrent URL durations are not summed. |
| `totalMs` | Adapter elapsed time through redirect completion, including local response processing. |

Values are milliseconds from `performance.now()`, so wall-clock adjustments do not distort durations. The difference between total time and the two named stages is local processing overhead. A batch with no redirect URLs normally takes near-zero time; it is still measured.

These are timings for the **successful adapter attempt**. The existing worker operation duration includes caller retries, backoff, stop checks, and logging overhead. Failed searches continue to use the existing error/retry trace; they do not fabricate successful timing results. Provider-internal model versus search timing is unavailable through this response. Existing audit runs cannot be backfilled.

The added timings neither alter token/cost calculation nor add provider calls, change timeouts, or change retrieval behavior. They remain diagnostic data; research summaries and source lists sent to generation and creation-chat consumers are selected explicitly.

Implementation: `packages/core/src/adapters/types.ts` defines the optional contract; `packages/core/src/adapters/gemini.ts` measures the provider and redirect boundaries. The existing `LoggingResearchAdapter` already logs the complete result, requiring no new storage format or database migration.

Validation:

- Three adapter cases use a controlled monotonic clock to distinguish 1,200 ms of provider time, 25 ms of local processing, and 300 ms of redirect work. They cover resolved redirects, failed redirects retaining the original URL, and direct URLs requiring no fetch. All three first failed without the timing implementation, then passed.
- Two integration fixtures pass the real Gemini adapter through the real worker logger into `MemoryObjectStore`, reconstruct the durable JSONL, and verify timing fields and call/job correlation with and without token usage. Metered calls retain the same exact token accounting; unmetered calls remain unpriced.
- Targeted core/worker suites: **75 tests passed** across six files. Full `pnpm check`: **all seven gates passed in 189.2 seconds**. Output: `.scratch/research-timings-2026-09-23/pnpm-check.log`.
