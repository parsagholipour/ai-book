# Sequential whole-book improvement

The user requests continued implementation and experimentation until one completed book scores 8+, generating only one book at a time. This supersedes earlier plans for three generation replicates and the cancellation of future launches. Parent owns diagnosis, intervention design and verification. Claude Code `claude-fable-5-1` at `xhigh` implements bounded specifications. Sol assesses the books.

## Fixed evaluation and stop rule

Use the original 120-page English historical survey request and approved composed-7 outline as the first candidate's input, with the same flat stance positions and balanced writer routing. Keep the original scope and length request. No manually rewritten manuscript passages enter a generated candidate.

Generate one complete manuscript through the normal pipeline. Freeze its code and settings during generation. Once generation/export completes, give the entire manuscript separately to three fresh `gpt-5.6-sol` assessors using the unchanged `rubrics/blind-rubric.md`. Assessors receive no previous scores, intervention description, threshold, other books or other verdicts. The parent verifies arithmetic and every quoted highlight/pattern against the manuscript. The primary result is the unrounded equal-weight mean of all ten criteria across all three readers. Stop generating when that mean is at least 8.0. Do not ask for replacement judges because a result disappoints.

If a book scores below 8.0, diagnose its complete verdicts and source text before one revised implementation and the next single-book generation. Preserve every launch, failure, complete manuscript, score and cost. No parallel book generation and no paid chapter-only prose tests. Unit and integration tests remain necessary implementation checks. A passing book is evidence for that book, not a claim of a reliable population mean or independently fact-checked history.

## First intervention: connect the material plans

Observed code path: the worker gathers chapter episodes before calling `planChapterForms`, but does not supply them to that planner. The form planner independently allocates cases while the writer is separately ordered to build the chapter around its episodes. The writer also cannot see cases reserved for future chapters. Earlier whole-book readings found recurring cases and conclusions across chapter boundaries.

Prediction: giving the existing form planner its actual episode assignments, and giving each writer/editor compact reservations for other chapters, will reduce conflicting assignments and repeated full case treatments. The episode planner receives one ownership/contribution instruction. This adds no model calls, keeps two or three episodes per chapter, does not expand source retrieval, and leaves word budgets intact. The old three experimental development gates stay disabled. No new rhetorical shape or compulsory ending is assigned.

Alternative explanations remain: an overbroad outline may require a substantive redesign; insufficient detail within cases may still produce padding; a stronger writer may be needed. The first run tests the information-flow repair before adding another planning layer or changing model routing.

Record actual routing, source code hashes, effective quality settings, job wall time, provider costs, completed chapter/word/page counts and all literary assessments with the run. Provider prices omit parent/Sol usage and unpriced services; report those limits explicitly.

## Second intervention, after candidate 1 scored 7.1

Candidate 1 (`material-routing-1`, project `cmto7ood00000keg0vnxinawr`) completed all 15 chapters and 120 stored pages (106 PDF pages). Sol readers scored 7.0, 7.1 and 7.2; all three gave pacing 5 and slop resistance 4. All 54 quoted highlights/pattern instances were verified verbatim, and each reader recorded all 15 chapters. The source code stayed unchanged during the run. The Chapter 6/7 case duplication disappeared, but the same institutional explanation still recurs in the chapter conclusions.

Ranked explanations for the remaining problem: (1) the writer and editor still receive the same five global positions for every chapter, with no distinct explanatory task; (2) two episode summaries and a handful of extracts leave a 4,000-word chapter room to repeat its argument; (3) the nonfiction scene call explicitly invites doing/seeing/saying and permits reconstruction, then imposes a minimum length, rewarding unsupported particulars. All three are observed in the generated text and supplied prompts, not merely inferred from a score.

The next candidate extends the existing episode-planning response with optional chapter-specific questions, investigation topics, contribution and already-established knowledge. These fields pass through the form planner, writer and editor; focused chapters write from their own question while retaining the same style exemplar and book context. Longer chapters receive three or four assigned episodes. Source retrieval stays within its existing bounds. No extra planning or polishing calls are introduced. The second change makes nonfiction scenes dependent on supplied excerpts, forbids invented scene-level details, accepts short accounts and removes minimum-length retries. This is a combined editorial intervention, not a single-variable causal test.

Keep the same original request, outline, balanced writer, length budgets and quality revision 49 for candidate 2. Do not reuse candidate 1's episodes, so the new planning contract is actually exercised. The original whole-book rubric, three fresh blinded Sol readers and 8.0 stop threshold remain unchanged. Generate only candidate 2, then evaluate before another launch.

## Third intervention, after candidate 2 scored 6.8667

Candidate 2 completed all 15 chapters and 120 stored pages (117 PDF pages), but fresh Sol readers scored 6.7, 6.8 and 7.1. The fixed three-or-four episode instruction produced three cases in every chapter, and every reader identified that repeated chapter architecture. The writer still had to develop every case at length and follow section-form word quotas, while the editor was told to reinstate the same quotas and statistical shape targets.

Candidate 3 removes those requirements from focused nonfiction. Its existing episode planner may choose one to four episodes with unequal treatment according to the question and evidence. The writer/editor follow the investigation rather than a fixed form sequence, retaining their full chapter word budgets, material, context, factuality rules, strict reconstruction constraint and existing output checks. The legacy path stays unchanged. No added model calls or enabled development gates. This is a combined structural intervention; it cannot identify each prompt change's separate contribution.

The user explicitly clarified on 6 September: **only Luna for writing**, with Sol retained for assessment. Use the same balanced Luna route, 120-page request, approved outline and quality revision 49. No Sol-writer test is authorized or has been launched. Freeze candidate 3 before generating, then run the unchanged three-reader whole-book assessment before any further book.

## Fourth intervention, after candidate 3 scored 7.0333

Candidate 3 completed in 25.61 minutes and scored 6.8, 7.6 and 6.7. All readers still identified the recurring methodological caveats and institutional conclusions. All thirty live prose requests confirmed the intended prompt change, so this is not explained by stale code. The inherited eight-pages-per-chapter outline still carries method-heavy voice guidance and promises, and the original user brief allows the book's shape to be decided during planning.

Run the current planning pipeline afresh from the same original creation brief and 120-page target. Do not pass reuse-plan or the old stance override. A new plan, chapter length allocation, stance and downstream material are the combined intervention; existing code and live quality settings remain fixed. This is the first candidate in this sequence to test current initial planning rather than the old approved outline. Inspect the plan for user-scope and total-page preservation, verify actual Luna routing, and retain all results. The unchanged three-fresh-Sol whole-book mean and 8.0 stop rule still apply. Only one book at a time.
