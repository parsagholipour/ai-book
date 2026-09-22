# Source retrieval options — 21 September 2026

Recommendation: fix the evidence pipeline using the existing Google-grounded research provider first, then compare Perplexity Search and Exa against that repaired baseline. A provider change can improve discovery and extraction; it does not establish that a particular passage supports a particular sentence. This is a documentation/code review, not a live provider benchmark. No application settings were changed.

## What the audit establishes

The [20-page audit](tier-audit-20-pages-2026-09-20.md) found no dossier documents or excerpts in Premium's five chapters. General web discovery is gated by `options.evidence` in [dossier.ts](../packages/core/src/generation/dossier.ts); the saved audit configuration has `caseEvidence: []`. The existing [composed evidence flow](../apps/worker/src/generation/composedEvidence.ts) already retrieves passages, builds case claims and retries inadequate evidence, providing a starting point for broader historical and technical claim checking.

The immediate engineering hypothesis is a retrieval-scope and evidence-enforcement problem, before a search-provider problem. The original [RSA paper](https://people.csail.mit.edu/rivest/Rsapaper.pdf) and [Diffie–Hellman paper](https://ee.stanford.edu/~hellman/publications/24.pdf) are publicly accessible on their authors' institutional sites. Searching general web sources is therefore directly relevant to this test brief.

## Provider shortlist

| Option | Useful capabilities | Assessment for this application |
| --- | --- | --- |
| Existing Google-grounded research | Gemini returns model text plus source links and mappings between answer segments and sources. Those mappings describe the generated answer, rather than supplying original document passages. [Google documentation](https://ai.google.dev/gemini-api/docs/generate-content/google-search) | Lowest integration cost: use source URLs for discovery, then the existing bounded HTML/PDF fetcher and exact-passage extraction. Establish this baseline first. |
| Perplexity Search API | Ranked URLs and extracted page content; domain, language and date filters; adjustable total and per-page content budgets; up to 20 results. [Search guide](https://docs.perplexity.ai/docs/search/quickstart), [API reference](https://docs.perplexity.ai/api-reference/search-post) | Good first challenger for broad discovery. Use raw results, retain source provenance and fetch original context where needed. The reviewed reference does not establish a PDF extraction guarantee. |
| Exa Search / Contents | Search exposes domain/path filters, publication category, text and highlights. Contents accepts URLs, including PDF examples, and returns extracted text with cache/live-crawl controls. [Search reference](https://exa.ai/docs/reference/search), [Contents reference](https://exa.ai/docs/reference/get-contents) | Strong alternative when extracting papers and source passages is the bottleneck. Test its returned highlights against original context; a highlighted passage still needs a support judgment. |
| Tavily Search / Extract | Domain restrictions/preferences, source chunks and optional parsed page content; separate Extract returns content and explicit per-URL failures, with deeper extraction for tables/embedded material. [Search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract reference](https://docs.tavily.com/documentation/api-reference/endpoint/extract) | Practical third candidate if the shortlist cannot retrieve enough evidence. The reviewed references do not establish PDF/OCR coverage; test the actual corpus. |

Perplexity **Search** and **Sonar** are different choices. Search returns data for our own pipeline. Sonar produces an answer and charges for model tokens plus request/search usage; the current documentation places Sonar under legacy APIs. Swapping one generated research summary for another would leave the missing passage-to-claim checks intact. [Perplexity Search guide](https://docs.perplexity.ai/docs/search/quickstart), [pricing](https://docs.perplexity.ai/docs/getting-started/pricing)

## Illustrative search costs

These are current published USD list prices, excluding free credits, taxes, our writer/verifier tokens, infrastructure and retries. The 40–100 search range is an **illustrative budget**, not a measured requirement for a 20-page book. The first table assumes one query per request.

| Retrieval option | Published unit price | 40 requests | 100 requests |
| --- | --- | ---: | ---: |
| Perplexity Search | $5 / 1,000 successful requests; no additional search token charge | $0.20 | $0.50 |
| Exa Search, up to 10 results | $7 / 1,000 requests, including text/highlights for those results | $0.28 | $0.70 |
| Tavily basic, pay as you go | 1 credit/request at $0.008/credit | $0.32 | $0.80 |
| Tavily advanced, pay as you go | 2 credits/request at $0.008/credit | $0.64 | $1.60 |

Sources: [Perplexity pricing](https://docs.perplexity.ai/docs/getting-started/pricing), [Exa pricing](https://exa.ai/pricing), [Tavily credits/pricing](https://docs.tavily.com/documentation/api-credits).

Perplexity permits up to five queries in one successful request for the same request fee: fully batching 40–100 queries would cost $0.04–$0.10. Evaluate result coverage before relying on this optimization. Exa's separate Contents costs $1/1,000 pages **per content type**, so 100 text-only pages add $0.10; search already includes text/highlights for its first 10 results. Tavily's separate Extract bills per five successful URLs: 100 URLs add $0.16 basic or $0.32 advanced at the pay-as-you-go rate. Extra Exa results and summaries have separate charges. Sources: the three pricing pages above.

These are retrieval costs, not a complete research or book-generation bill. Feeding every returned page into every chapter can cost more than search itself. Cache documents by canonical URL/content hash and send only relevant, attributable passages to the writer and verifier.

## What to measure before choosing a provider

1. Freeze the same brief, plan, required claims and writer settings. Compare the current pipeline, a repaired Google-backed pipeline, and the same repaired pipeline with Perplexity Search or Exa.
2. Score whether each required claim has a relevant primary document, a usable exact passage, and a supported/contradicted/insufficient-evidence decision. Audit all numerical, quotation, historical-specificity and security claims. Treat unclear support as unresolved.
3. Inspect the finished prose, including facts introduced during writing or editing. Compute toy mathematics deterministically: 187 has 8 bits, so no retrieved source is required to reject its description as a 2048-bit modulus.
4. Record source retrieval success, empty chapters, supported-claim coverage, false support judgments, remaining factual errors, p50/p95 latency and total cost. Test multiple subjects and runs; vendor benchmarks do not predict this book workload.

Expected improvement is directional, not a defensible percentage yet. Enabling missing discovery should improve available evidence; claim checking and repair should reduce unsupported or contradicted statements. A new search provider adds value only when it finds usable evidence the repaired baseline misses, or reduces extraction failures/cost/latency. Prefer the smallest retrieval stack that meets the measured quality target.
