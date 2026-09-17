# Full-document sources

Uploads can be retained as versioned private sources, independently of chat JSON and original-file retention. This ships disabled by default.

## Rollout

1. Apply `packages/db/prisma/migrations/000071_full_document_sources/migration.sql` through the normal deployment migration process.
2. Set `FULL_DOCUMENT_SOURCES=true` on the API and worker. Keep `ATTACHMENT_STORAGE_DIR` shared between them. Development Docker Compose supplies `SOURCE_OCR_URL=http://ocr:8080` to the worker. OCR health does not block worker startup, so configured Google fallback can handle pages while local OCR starts or is unavailable. The worker polls durable extraction jobs every two seconds, with one active document per worker and at most two concurrent PDF OCR calls per document.
3. Release the mobile changes. New clients send `async=true`; older clients omit it and wait for ingestion. A synchronous timeout returns `SOURCE_PROCESSING`; resending the same upload reuses its saved job.

Turning the flag off stops new source ingestion and backfill. Existing frozen source versions remain readable and continue to supply generated books.

The upload limits remain eight files per chat and 20 MB per file. Extracted content is limited to 1,500,000 characters; PDFs are limited to 600 pages. Exceeding either extraction limit fails explicitly and blocks building rather than silently accepting a prefix.

## Storage and processing

- `SourceDocument` owns upload identity, account ownership, filename and original-file location. Upload request keys are unique within a draft. Without a client key, the SHA-256 content hash is the key. Concurrent/replayed uploads take a draft row lock; a reused key with different bytes is rejected.
- `SourceExtraction` is the durable processing job and extraction version. Expiring leases fence checkpoint writes; abandoned leases are reclaimed. Successful extraction, page checkpoints, chunks and summaries survive interrupted attempts. Processing updates never advance the chat revision.
- `SourceChunk` stores ordered, verbatim passages, locators, section summaries and optional embeddings. Native PDF text uses Poppler. Pages with unreadable text or embedded imagery go through the OCR adapter: local PaddleOCR-VL 1.6 first when configured, then Gemini fallback when available. OCR returns structured Markdown for readable text, tables, formulas and diagram labels. Unavailable or unreadable regions are recorded explicitly. DOCX, EPUB and text reuse local parsers. Tables retain tab-separated columns where present or Markdown structure from OCR.
- `ProjectSource` retains selected versions when a book is built. Plan input snapshots carry `mediaSettings.mobile.sourceRefs`. Retries create a new version; existing books keep the old evidence. Original files retain the existing 180-day policy. Extracted passages survive original expiry and draft deletion while referenced by a book.

Automatic attempts are bounded. Partial/limited sources require an explicit “Use readable content” choice or a retry before Build can proceed. If a summary provider is not configured, a labelled extractive overview remains available; full passages still support lexical retrieval. Embedding failure does not discard extraction or summaries.

PaddleOCR-VL is pinned in `Dockerfile.ocr`, and its model weights are downloaded during the image build. Successful local OCR requests remain inside the Compose network. The service runs on CPU. `SOURCE_OCR_TIMEOUT_MS` defaults to ten minutes so two concurrent CPU page requests retain enough headroom.

With `GEMINI_API_KEY` configured, Google Gemini handles OCR when `SOURCE_OCR_URL` is unset or the local service fails. Empty or partial local results also trigger a Google attempt; if that attempt fails, the local result and its unreadable markers are preserved. The fallback sends the affected image or single PDF page to Google and incurs Gemini API usage. Complete local extraction does not call Google. Native-text PDFs and locally parsed text/DOCX/EPUB files continue to use their existing extraction paths. `MOCK_AI=true` keeps OCR offline. Without a Gemini key, the existing local-only behavior remains: unavailable visual content is recorded as unreadable, and failed image extraction can be retried.

`GEMINI_OCR_MODEL` optionally selects a separate OCR model; otherwise OCR uses
`GEMINI_TEXT_MODEL` (default `gemini-2.5-flash`). `SOURCE_OCR_TIMEOUT_MS` applies to
each provider request, so a local timeout followed by a Google request may take
up to two such budgets. Google token usage is returned to the worker's existing
source-usage accounting. No provider keys are needed for the mocked tests.
Google fallback accepts PDF, JPEG, PNG, WebP, HEIC, and HEIF. GIF/BMP still require
successful local OCR or conversion to a supported format; unsupported Google
input fails explicitly rather than being recorded as a successfully read blank page.

Google's [document input](https://ai.google.dev/gemini-api/docs/document-processing)
and [image input](https://ai.google.dev/gemini-api/docs/image-understanding)
documentation describe the provider formats used by this adapter.

Background backfill processes retained draft originals. An expired original becomes a `limited` legacy digest. Existing plan snapshots are upgraded once their legacy source set is available. Source IDs and extraction versions are then frozen in the snapshot.

## Chat and generation

Creation chat receives only files submitted on its active branch. Unsent uploads stay outside model access, and folding a shared transcript prefix carries attachment references forward.

`search_sources` combines lexical relevance (including rare-name/number weighting) and cosine similarity with reciprocal-rank fusion. Both use the same owner/version scope. Lexical retrieval remains available when embeddings fail. `read_source` returns a passage or the complete section overview of a selected document. For several documents, first read the catalogue and then each relevant document's section overview.

A response may cite only a passage returned during that turn, using `[source:ID:VERSION:ORDINAL]`. Unknown references become `[unverified source]`. The app opens citations through an authenticated passage endpoint. These citations are separate from public web research and never create `ResearchSource` URLs.

The source-aware generation adapter supplies document summaries and relevant passages to planning, chapter preparation, page writing, composed chapters, continuation, rewrites and judges. Review calls also reload the exact passages cited by their candidate. Generated citation markers are validated against supplied evidence. This checks reference validity; semantic claim support still belongs to the reviewer.

## API additions

- `POST /api/mobile/creation-sessions/:id/attachments?filename=...&async=true&requestId=...`: returns 202 with saved attachment metadata and its processing state. Omit `async` for synchronous compatibility.
- `GET /api/mobile/creation-sessions/:id/attachments`: fresh processing metadata without a chat revision mutation.
- `POST /api/mobile/creation-sessions/:id/attachments/:attachmentId/retry`: `{ requestId, version }`.
- `POST /api/mobile/creation-sessions/:id/attachments/:attachmentId/use-readable`: `{ requestId, version }`.
- `GET /api/mobile/sources/:sourceId/versions/:version/passages/:ordinal`: authenticated passage viewer data.

Processing metadata includes status, percentage, readable and total sections, coverage gaps, retry availability, acceptance and a user-safe failure message. Provider details are excluded from mobile responses. The extraction row's `usage` contains call counts, observed token usage, elapsed processing time and extracted character count; failed physical calls can have no token usage.

## Validation

`pnpm check` covers source extraction/retrieval/generation tests and branch, owner and endpoint tests. PDF fixtures exercise real Poppler with native, scanned and mixed pages, unreadable regions and the 600-page ceiling. `pnpm check:mobile` includes citation-viewer and processing-response tests.

`scripts/evaluate-source-documents.ts` is an offline integration evaluation against an isolated database whose name contains `codex_sources_test`, initialized with the current schema. Set `DATABASE_URL` for that disposable database, then run:

```sh
pnpm exec tsx scripts/evaluate-source-documents.ts
```

It creates fixture accounts and uploads and is intended for a fresh, disposable database. It checks durable recovery, duplicate requests, a fact beyond 160,000 characters, summary coverage, creation and book-chat citations, a fixture-written chapter, extraction retries, original expiry, legacy snapshot upgrade and draft deletion. Its output includes latency and provider usage. It forces mock AI: it measures plumbing and fixture correctness, not live model answer accuracy or production provider latency.

After that script, run `pnpm exec tsx scripts/evaluate-source-answers.ts` with the same disposable `DATABASE_URL` and configured provider credentials. This second script makes live provider calls using only synthetic fixtures. It checks deep facts, conflicting documents, complete section overview use, missing evidence, and a generated chapter paragraph. It verifies expected facts and that their cited passages were actually returned and contain those facts. It deliberately uses lexical fallback. The final source-chat call is reserved for answering from the evidence already retrieved; it cannot spend the entire turn searching and leave an unfinished acknowledgment.

`scripts/evaluate-source-live-pipeline.ts` adds the full local OCR acceptance path. It creates an image-only PDF, uploads it through the real database service, runs the durable worker against `SOURCE_OCR_URL`, verifies exact OCR facts and provider accounting, then asks the live chat model for a cited answer and checks that the cited passage contains every requested fact.

On 2026-09-08, the nine offline integration checks passed. The five live fixture checks passed with `deepseek-v4-flash`: individual calls/turns took 1.4–8.5 seconds, with 61,211 input tokens and 2,419 output tokens across the evaluation (30,848 input tokens reported as cache hits). The local OCR acceptance also passed: PaddleOCR-VL recovered every asserted name, number, passcode and location from the synthetic image-only PDF; the worker completed in 215,967 ms with one OCR call, two live summary calls and one embedding call; the cited answer completed in 2,950 ms. The image was about 2.25 GB and the warm CPU service used about 6.6 GB RAM during the run. These are small-fixture results, not a broad accuracy benchmark. Earlier live trials exposed invalid summary citations, exhausted missing-evidence searches and a lazy font download in Paddle's response renderer; the final implementation reserves an answer call, supplies explicit overview citation instructions, disables response visualization and bakes a Unicode font into the OCR image. Production-sized multi-document load still needs rollout monitoring.

The full-repository `pseudocodeHighlighting.test.ts` failure also reproduces on the unchanged `HEAD` baseline; it is unrelated to source handling.

### Live book, plan and message acceptance (2026-09-08)

`scripts/evaluate-source-books.ts` runs the production worker processor against a disposable PostgreSQL database and dedicated Redis on port 16389. It uses live DeepSeek text calls and real embeddings, freezes a synthetic uploaded story bible into a plan, generates a three-page book with the whole-book strategy, delivers the worker's export follow-up, checks persisted pages and the PDF, and calls the production creation-chat and grounded-book-answer functions. HTTP authentication/billing and Flutter interaction are outside this test. Optional character-library follow-ups are not delivered. Generated acceptance artifacts are temporary and are not committed. It caps each text response at 5,000 tokens and the accumulated run at 24,000 output tokens, and retains artifacts in `.scratch/source-book-live`.

Observed results:

- Plan creation passed: one chapter, three planned pages, all four exact source facts preserved, and the selected extraction version retained.
- Book generation and export passed: three completed manuscript pages, two PDF pages, a resolved ending, all four source facts retained, and three resolvable private citations. PDF, EPUB and DOCX were produced by the worker. PDF text and both rendered pages were inspected.
- Creation chat passed: the requested passcode and inventory count were returned with a valid source citation.
- Book factual chat passed: passcode, inventory count and lens location were answered with valid source citations.
- **Strict missing-evidence attribution failed:** the answer correctly says the source gives no exact calendar date, but also says the upload specifies “at dusk.” That detail exists only in the generated story. Stronger instructions did not reliably prevent the conflation; the acceptance script keeps this failure visible.
- **Export presentation remains incomplete:** the PDF prints raw `[source:…]` identifiers instead of readable source labels. No clipping or missing text was observed.

Live testing exposed and prompted fixes for an unstated 600-character source-summary limit, conflicting public/private citation guidance during book generation, and book chat copying manuscript citations before retrieving source evidence. The added grounded-answer regression test checks that retrieved passages enter the current turn's citation ledger before a direct model answer.

Across setup, generation and repeated message checks, 26 text calls consumed 82,632 input tokens and 12,841 output tokens. One plan was generated; the three-page manuscript was generated twice to verify the citation fix. These small synthetic tests do not establish broad factual accuracy or cloud/local OCR parity. The strict acceptance result is **not fully passing**; rerunning the script writes `results.json`, `plan.json`, `manuscript.md`, and worker logs under `.scratch/source-book-live` for inspection.

### 80-page native-text acceptance (2026-09-08)

Run `scripts/evaluate-source-books.ts` with `SOURCE_BOOK_EVAL_PDF80=true` and `SOURCE_BOOK_EVAL_OUTPUT=.scratch/source-book-pdf80`, using the disposable database/private Redis described above. The synthetic PDF contains 80 native-text pages, no images, unique page markers, and controlled facts on pages 1, 40 and 80. Repeated maintenance records make this a coverage and distant-evidence test, not a broad accuracy benchmark.

The live run passed extraction, retrieval, planning, book generation/export, creation chat, factual book chat and missing-evidence checks. All 80 pages and 80 embedded chunks were retained: 237,619 extracted characters, zero OCR calls, and the final fact at character 234,649. One three-page manuscript was generated and rendered as a two-page PDF, with eight resolvable citations. Raw source IDs remain visible in the PDF; passing citation resolution does not establish correct attribution of every sentence. The earlier small-fixture attribution failure remains a known limitation.

The run consumed 149,422 input and 22,738 output text tokens across 96 calls, including an initial failed summary attempt and checkpoint recovery. Most calls summarized input pages; the book stayed below the requested 15-page ceiling. Rerunning the test writes temporary artifacts under `.scratch/source-book-pdf80`, including `results.json`, `usage.json`, `extraction.json`, `plan.json`, `manuscript.md`, and the input and output PDFs.

After the run, the hard 600-character model-summary limit and length-triggered fallback were removed. Concise instructions and the existing 300-token call budget remain. A separate live call using page 80 returned a 712-character summary with the expected final facts, preserved verbatim (702 input and 147 output tokens). The full 80-page generation was not repeated after this change. A regression test verifies that summaries beyond 600 characters are retained without truncation or retries.
