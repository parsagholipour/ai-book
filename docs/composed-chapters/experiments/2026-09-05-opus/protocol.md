# Opus comparison protocol — 5 September 2026

Registered before any verdict was read. This is the Opus-panel counterpart of `../2026-09-05-sol/protocol.md` and
`../2026-09-05-fixes/protocol.md`: the question is whether the development pipeline (research-led planning, case
evidence, developmental editing; implementation-5 of the fixes experiment) produces a better book than the shipped
rung-5 configuration, judged by the instrument every earlier rung was judged by — three independent Opus readers a
book on the unchanged ten-criterion rubric in `../../rubrics/blind-rubric.md`.

**Arms.** `new`: every completed balanced-tier book of the development pipeline on the shared plan (project
`cmtjlkn0z0000g8g08zbzxerc`'s plan as the coverage inventory, flat stance positions, designed cover), target three
replicates. `baseline`: the three rung-5 apparatus books (`ladder-5a/5b/5c-apparatus`). `reference`: the original
composed-7 book. Every arm is read in this sitting, because the panel drifts by about 0.6 between sittings
(README, "How to read the numbers"); no historical Opus or Sol number is subtracted from a score taken today.

**Readers.** One Opus agent per (book, reader letter), fresh context, given only the blinded manuscript path, the
rubric, and the output paths. No arm label, no past score, no code, no trace, no other manuscript, no web. Readers
read the whole file in sequential chunks and record the chapter titles they read and the word count.

**Primary result.** Difference in the equal-weight ten-criterion mean, averaging readers within a book and then
books within an arm: `new` against `baseline`. Also per criterion, per book, per reader. A three-book arm mean is
±0.4 (README); differences under that are reported as unresolved, not as improvement or regression.

**Validation.** `summarize.py` checks manuscript hashes and word counts, every reader's chapter list, score ranges
and arithmetic, and that every quoted highlight and pattern instance is verbatim in the assigned manuscript.

**Rules.** No failed or incomplete generation is scored. A completed low-scoring book is kept. The rubric is not
edited after a verdict exists. Every launch, failure and export stays in `../2026-09-05-fixes/manifest.json`.
Secondary readouts: completion, cost, word count, the deterministic scorecard (`scripts/structural-scorecard.ts`).
