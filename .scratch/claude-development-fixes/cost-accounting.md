# Development-fixes experiment: cost, calls and runtime (captured 08:20 UTC, 5 Sep 2026)

Data collection only. Sources: `ProviderCallLog` grouped per job/purpose (psql export `providercalls-by-job-purpose.txt`), `GenerationJob` rows (`jobs.txt`), run traces under `storage/books/<projectId>/runs/`, and the rung-5 baseline `trace.json` files under `docs/composed-chapters/runs/`. Machine-readable detail, per job and per purpose, is in `cost-accounting.json` beside this file. USD figures are the provider-estimated `costHint` of settled gpt-5.6-luna calls; nothing else was priced.

## 1. Totals

| | provider-estimated USD | luna calls | research searches (unpriced) |
|---|---|---|---|
| Project 1 `cmtnwyp3d0000fwg07qgd68uo` (1a … 1d) | 2.371 | 546 | 188 |
| Project 2a `cmtnyg6ji0000seg0lrlewwb1` (2a … 2a-retry-3) | 2.217 | 407 | 130 |
| Project 3a `cmtnzo7wf0000qwg0kwq6s3rk` (another session) | 2.360 | 454 | 144 |
| **All experiment spend** | **6.948** | **1,407** | **462** |
| of which the one completed generate-book job (1d) | 1.598 | 210 | 0 |
| of which failed or stopped generate-book attempts (12) | 5.316 | 1,172 | 462 |
| of which compile, character candidates, image jobs | 0.034 | 25 | 0 |

Rung-5 baseline (three completed 120-page books on the same plan, `ladder-5a/5b/5c-apparatus`): **$0.399–0.425 (mean 0.416), 88–96 calls (mean 92), 26–57 summed provider-duration minutes (mean 41)** for the whole book including its preparation and compile. These historical trace minutes are not wall-clock runtimes and must not be compared directly with job elapsed time. The composed-7 reference: $0.482, 105 calls, 23 summed provider-duration minutes.

## 2. Every attempt

| label | job | launched by | implementation | status | elapsed min | calls | USD | ended on |
|---|---|---|---|---|---|---|---|---|
| 1a | cmtnwyp4a… | parent | 1 | FAILED@15 | 1.1 | 2 | 0.011 | operator stop after the source-timeout cancellation |
| 1a-retry | cmtnx6j3k… | parent | 2 | FAILED@16 | 18.9 | 123 | 0.236 | thesis string-equality check in `developBookPlan` |
| 1b | cmtny8hzz… | this session | 3 | FAILED@16 | 16.1 | 83 | 0.192 | "chapter 7 has no evidence assigned" rule |
| 2a | cmtnyg6l0… | this session | 4 | FAILED@16 | 11.8 | 78 | 0.173 | model review rejected the developed plan twice |
| 1c | cmtnz1i25… | this session | 5 | FAILED@25 | 21.4 | 106 | 0.301 | chapter-1 evidence findings after one repair; pass threw |
| 2a-retry | cmtnz1nxq… | this session | 5 | FAILED@25 | 23.5 | 106 | 0.302 | reviewer quote not locatable; review threw |
| 3a | cmtnzo7xh… | other session | 5 | FAILED@15 | 8.1 | 32 | 0.075 | stopped (driver log "FAILED@15 Stopped") |
| **1d** | cmto0e92v… | this session | 6 | **COMPLETED** | **51.8** | **210** | **1.598** | published REVIEW_REQUIRED at 07:27:52 |
| 2a-retry-2 | cmto0eefi… | this session | 6 | FAILED@71 | 45.7 | 193 | 1.398 | word floor: 50,194 < 51,600 with 120 pages staged |
| 3a-retry | cmto0menm… | other session | 6 | FAILED@16 | 13.6 | 78 | 0.190 | `max_output_tokens` on a develop-book-plan schema repair |
| 3a-retry-2 | cmto1586m… | other session | 6 | FAILED@71 | 62.1 | 309 | 1.749 | word floor: 46,651 < 51,040 |
| 2a-retry-3 | cmto3sjcv… | other session | post-6 | FAILED@71 | 8.8 | 29 | 0.344 | stopped by another session 08:19:45 (polishing ch. 6/15) |
| 3a-retry-3 | cmto3spgk… | other session | post-6 | FAILED@71 | 8.8 | 34 | 0.345 | stopped by another session 08:19:49 (polishing ch. 7/15) |

Elapsed is `finishedAt − startedAt` from `GenerationJob`. Project 1's wall clock across its five attempts ran 04:59 → 07:28 UTC. Failure messages are quoted in full in `cost-accounting.json` (`jobs[].trace.failed`).

## 3. Where the completed job's money and time went (1d, 51.8 min, $1.598)

1d resumed from the developed plan and evidence packets that 1a-retry, 1b and 1c had already persisted on the project, so it paid no episodes, sources, evidence-packet or development-plan stage; those cost $0.19–0.30 and 12–19 minutes per attempt on this plan (see 1a-retry, 1b, 1c rows). A single uninterrupted run would therefore be about **$1.8–1.9 and 65–70 minutes**, against $0.42 and 41 minutes for a rung-5 book.

| stage (purposes) | 1d calls | 1d USD | 1d summed call time | rung-5 mean calls | rung-5 mean USD |
|---|---|---|---|---|---|
| line edit (`edit-chapter`, `rewrite-couplets`) | 73 (58 + 15) | 0.811 | 28.5 min | 30 (15 + 15) | 0.149 |
| chapter evidence review (`review-chapter-evidence`) | 82 | 0.466 | 11.2 min | 0 | 0 |
| compose (`compose-chapter`) | 22 | 0.196 | 18.4 min | 22.7 | 0.134 |
| describe pages (`describe-pages`) | 30 | 0.083 | 5.2 min | 15 | 0.044 |
| developmental edit (`plan-developmental-edit`) | 1 | 0.026 | 0.2 min | 0 | 0 |
| chapter forms (`plan-chapter-forms`) | 2 | 0.016 | 1.5 min | 2 | 0.019 |
| manuscript read (`read-manuscript`) | 0 | 0 | 0 | 1 | 0.022 |
| finalize / compile / other | 0 in this job (compile job: 3 calls, $0.010) | | | 8 | 0.016 |

Facts behind the two largest lines, from the traces and the code paths that emit these purposes:

- `review-chapter-evidence` is emitted by `reviewChapterCaseEvidence` (core `caseEvidence.ts`), called after each chapter's line edit by `repairChapterEvidence` (worker `composedEvidenceRepair.ts`, implementation-6) and again after the developmental edit's polish; each call carries the whole chapter plus every packet with its excerpts (1,501,303 prompt tokens over 82 calls, 18.3k per call). It made 82 calls for 15 chapters because a chapter with findings is re-reviewed after each of up to two repairs, and the developmental-edit pass reviews every chapter again.
- `edit-chapter` ran 58 times against 15 in the baseline: the first line edit (15), the developmental edit's per-chapter polish (15), and the targeted evidence repairs (up to two per chapter per pass). Each call carries the full compose context (1,970,568 prompt tokens, 34k per call), so it is the single most expensive purpose at $0.798.
- `describe-pages` doubled (30 vs 15) because pages are described once after composition and once more after the developmental edit re-cuts the chapters.
- `compose-chapter` is unchanged in count and 1.5× in cost per call versus the baseline (packets travel in the prompt).

Stage spans in the trace overlap (chapters are composed, edited, reviewed and described in a pipeline): compose spanned 25.0 minutes, line edit / evidence review / describe 47 minutes, the developmental-edit planning call under a minute. The residual-findings path recorded `generation.composed_chapters.evidence_unresolved` for 9 of 15 chapters; the compile report shows 11 residual assertions on 11 pages.

For the two other jobs that reached the developmental edit (2a-retry-2, 3a-retry-2) the same stages cost $1.40 and $1.75; 3a-retry-2 additionally paid its own preparation ($0.24, 62 calls of evidence packets, 44 research searches).

## 4. Unpriced work

- 462 `research.search.request` events across the three projects (case-source-search queries answered by the research provider with a summary and URLs). No `ProviderCallLog` row exists for any of them, so their cost is unknown here.
- Document downloads (`sourceDocumentFetch`) write no run-log event; their count and bytes are not recoverable from these traces.
- Two `ProviderCallLog` rows (a `describe-pages` and an `edit-chapter` call) have no `costHint`: they were in flight when 2a-retry-3 and 3a-retry-3 were stopped.

## 5. What was running, and who owns it

At 08:18 UTC two experiment jobs were ACTIVE at progress 71 (2a-retry-3 `cmto3sjcv0000k8g052hxry5n`, 3a-retry-3 `cmto3spgk00000zg006emuzp4`). Both were launched at 08:10–08:11 UTC by another session (their driver logs `development-fixes-2a-retry-3.log` and `development-fixes-3a-retry-3.log` sit in the experiment directory; project 3a itself was cloned at 06:15:36 UTC by that session). Both carry `job.stopped` at 08:19:45 and 08:19:49 UTC and are now FAILED@71 "Stopped". This session stopped nothing and launched nothing after 06:36 UTC. No experiment job is active now. The two June 2026 ACTIVE jobs on unrelated projects are pre-existing.

## 6. Implementation provenance

Snapshots `implementation-1..6.json` (sha256 per dirty source file, tarballs beside them) are in the experiment directory; the job-to-implementation mapping is in §2 and in `cost-accounting.json` (`jobs[].implementation`). Since implementation-6 (06:36 UTC) another session changed, without a snapshot from this session: `composedDevelopmentalEdit.ts` (word floor replaced by a bounded length extension with a recorded shortfall, 08:09), `generateJsonWithRetry.ts` (one 1.5× output-budget widening on `max_output_tokens`, 07:03), `qualityGates.ts` (`bookDevelopment`, `caseEvidence`, `developmentalEdit` made explicit opt-in, default off, 08:20), the admin generated-books view, and `packages/core/src/generation/CLAUDE.md`. A worker process keeps the code it loaded, so a job's effective implementation is the tree at its `startedAt`.

## 7. Artifacts

- Completed manuscript: `docs/composed-chapters/runs/development-fixes-1d/` (book.md, pages.json, trace.json, trace.md, scorecard.txt); blinded copy `blind/J6/manuscript.txt` (52,119 words, 15 chapters, sha256 `0c7896a9…`), listed in `manifest.json` → `candidates.J6`; hand-off in `ASSESSMENT_READY.md`.
- Zero-page diagnostic exports: `runs/development-fixes-1a`, `runs/development-fixes-1a-retry`.
- Compile quality report for project 1: `GenerationJob.qualityReport` of `cmto28t9f01192cp2cspgbad0` (state `blocked`, score 54, four issues).
