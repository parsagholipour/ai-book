# Quality ladder — 2026-09-03 (opinion-fable-5 levers, built and measured one rung at a time)

Same plan as every earlier arm (composed-7's, `--reuse-plan cmtjlkn0z0000g8g08zbzxerc`, 120 pages, 15 chapters,
balanced tier, three replicates a rung). Instruments: the three-Opus blind panel (`blind-rubric.md`, nine readers a
rung), the scorecard with the new tight couplet counter (`scripts/structural-scorecard.ts`), a particulars-density
count (distinct proper nouns, years, numbers and quotations per 1,000 words; `scratchpad/particulars.py` in the
session), the provenance probe, and cost/time from the trace.

Parsa's directions during the session: every editing call stays on the selected writer model (Luna), never a second
family; the writer is not to be held to the research notes — creativity is allowed; the paradigm shift is to be tried.

## Rungs

| rung | change (cumulative unless noted) | panel overall | engagement | pacing | slop | couplets /1000 | proper /1k | quotes | $ / book | min |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (composed-23a/b/c) | iteration-23 pipeline | 7.46 | 6.0 | 5.7 | 6.6 | 34–44 | 9–12 | 2 | 0.33 | 27 |
| 1 (closed) | line edit on Gemini 3.7 Flash, not cumulative — rejected by Parsa mid-run and reverted | 7.17 (1a only: 7.0/7.1/7.4) | 6.0 | 6.0 | 6.3 | 10–28 | 12–21 | 2–14 | 0.55–0.58 | 18–21 |
| 2 | creative contract (writer may draw on its own knowledge; quotation marks a promise) | **7.76** (7.67 / 7.77 / 7.83; nine readers 7.3–7.9, all "light revision") | 6.67 | 6.0 | 6.78 | 31–34 | 16–22 | 2 | 0.33–0.37 | 36–43 (OpenAI slow) |
| 3 | + material-first: episodes → primary-source dossier → scene call → compose around the episode → quote guard | **7.62** (7.60 / 7.73 / 7.53; readers 7.1–8.3) | **7.22** | 6.11 | 6.11 | 27–34 | 19–22 | 8–23 (15/21 verbatim on 3c) | 0.38–0.42 | 23–46 |
| 4 | + couplet rewrite on the writer's own model | 7.51 (7.23 / 7.70 / 7.60) | 6.78 | 5.89 | 6.0 | **5–8** | 20–21 | 13–30 | 0.42 | 30–43 |
| 7 | + the amendments (landing exit silent, epigraph and exit two documents, person exit verbatim-only, landings spread) | 7.32 (7.60 / 7.17 / 7.20) | 6.33 | 5.78 | 6.33 | 6–8 | 20–22 | 19–28 | 0.37–0.42 | 25–32 |
| 6 | + assigned exits, scene form capped (scene call only where the form plan opens on one), repetition cut (inert) | 7.58 (7.97 / 7.60 / 7.17) | 6.56 | 5.89 | **7.0** | 5–7 | 19–21 | 18–41 | 0.38–0.41 | 26–33 |
| 5 | + chapter epigraph from the dossier, and no two consecutive chapters open on a told scene | **7.74** (7.47 / 7.87 / 7.87; readers 7.4–8.3) | 7.0 | 6.11 | 6.44 | 6–11 | 18–22 | 19–26 (33/43 verbatim) | 0.40–0.43 | 26–57 |

### Rung 5: the best composite, and where the pipeline is left
Nine readers, 7.74 (7.47 / 7.87 / 7.87), engagement 7.0, voice 8.22 and craft 8.22 (the highest of any rung),
depth 7.78, slop resistance 6.44 — back up from rung 4's 6.0 now that only 7–8 chapters of 15 open on a told scene
and each chapter with a dossier carries an attributed epigraph (Darius at Behistun, Yogananda, the Wannsee
Protocol; 8 a book). Readers' verdicts: eight "light revision", one "moderate". They still list a chapter-opening
set-piece, the paired-case comparison, the aphoristic one-liner and the closing rhetorical question; those are now
the whole of the pattern list, and they are what a further rung would be aimed at.

**The pipeline is left at rung 5** (quality revision 37: `creativeContract`, `materialFirst`, `coupletRewrite`,
`chapterApparatus` on for balanced; Luna edits its own prose). Against the baseline: overall 7.46 → 7.74,
engagement 6.0 → 7.0, quotations 2 → ~20 a book with a code-checked provenance, cost $0.33 → $0.42. Revision 34
(the creative contract alone) is the cheaper row at 7.76 / engagement 6.67 / $0.35 if the dossier's cost or its
ten-minute step is not wanted; `dev-set-quality.ts restore 34` returns to it, `restore 31` to the baseline.

### Rung 4: the tight couplet is gone from the page and the panel does not notice
The rewrite accepted 90–101 of 109–122 pairs a book (the acceptance test refused the rest), the couplet counter
fell from 27–34 to 5–8 per thousand sentences, and the pass costs $0.012 a book on the writer's own model. Nine
readers: 7.51, engagement 6.78, slop resistance 6.0 — inside the noise of rung 3 (7.62 / 7.22 / 6.11), not above it.
The readers' pattern lists no longer quote "X was not A. It was B." pairs; they quote the *paired-antithesis
closer* ("two short sentences that invert each other") and the thesis restated with the nouns swapped — the
sibling moves the detector does not reach — and, for the third rung running, the scene that opens every chapter.
Rung 1 showed the same thing from the other side: cadence measured by rule can be halved without the panel
moving. Keep the pass (it is cheap and the tic is real on the page), but do not expect the panel to pay for it.

### Rung 3: engagement crosses 7 for the first time on Luna; the scene becomes a template
Nine readers, 7.62 overall (within noise of rung 2's 7.76), but the criterion the whole programme was chasing moved:
engagement 7.22 against 6.67 (rung 2) and 6.0 (baseline) — the pre-registered target from the session report
(≥ 7.0) is met; pacing 6.11 is not (target 6.5). Slop resistance fell to 6.11 from 6.78 and depth to 7.67 from 8.0,
and the readers say why in one voice: "every chapter runs the same machine — a cinematic named-witness vignette
with sensory detail, a hinge sentence, the comparison". The scene call ran on 13–15 chapters of 15, and a prompt
present in every chapter is a template whatever it says (the arc's `dispute` lesson, again). Rung 5 rotates it: no
two consecutive chapters open on a told scene.

What the dossier delivered: 28–32 public-domain documents a book (Wikisource 25–30, archive.org 2–3), 19–24
verbatim excerpts over 6–8 of 15 chapters — Darius at Behistun, the Wannsee Protocol, Cortés's letters, Lilburne,
Burke, the Hittite Pentaur epic — and the books now carry 8–23 quotations (2 before), of which the guard finds
15 of 21 verbatim in the dossier on 3c; one misattributed quotation was stripped of its marks per book. The
model-supplied share of proper nouns fell to 27% from rung 2's 34% (sourced particulars displacing invented ones).
Cost +$0.05–0.09 a book: the scene call $0.02, the extraction $0.02, the episodes $0.005, longer chapters.

Three launches were lost to Wikimedia's rate limit before this one ran: nine parallel chapter builds drew a 429 on
every search (three archive.org documents for a whole book), a 300 ms per-host queue still drew 194 refusals in five
minutes, and the cadence that holds is one request every two seconds to Wikimedia hosts only (about thirty a minute),
a twenty-second back-off with two retries, one search per episode, a contact user-agent, and a ten-minute budget for
a whole book's dossier after which chapters compose with what was found. Both attempts are in the run logs; the
code that shipped is `primarySources.ts` (`throttledFetch`) and `dossier.ts` (`deadline`).

### Rung 2: the first arm in twenty-eight to move engagement
Nine readers, 7.76 against 7.46 for the same pipeline under the grounded contract: engagement 6.67 against 6.0,
depth 8.0 against 7.1, pacing 6.0 against 5.67, slop resistance 6.78 against 6.55, every verdict "needs light
revision". What changed on the page is measurable: distinct proper nouns per thousand words doubled (16–22 against
9–12), years per thousand rose (2.3–3.3 against 1.3–2.5), and the provenance probe puts the model-supplied share of
proper nouns at 34% (15% under the grounded contract) — the writer is now bringing what it knows, which is what
Parsa asked for and what the DeepSeek and Gemini sevens were made of. Cost is unchanged. The couplet fell a little
(31–34 against 34–44) and the readers still name the five moves, so the cadence work is still ahead. Readers' remaining
complaints: every chapter opens on a dated vignette and widens the same way; the one-sentence "gong" paragraph;
"the difference lay in…"; chapters ending on an open question.

### Rung 1, what it showed before it was closed
The couplet rate fell from 44 to 10 per thousand sentences on 1a and the panel gave engagement 6 and pacing 6 —
cadence is not engagement, as §2 of opinion-fable-5 predicted. Gemini as editor also tripled the edit's cost ($0.35
against $0.13) and added fourteen quotations and a thousand proper nouns the writer had not written, which is a
provenance risk on top of Parsa's objection. Reverted; the writer edits its own prose.

## What was learned, for the next session
1. **Material moves engagement; cadence does not.** Two rungs halved the couplet (1 and 4) and neither moved the
   panel; two rungs added particulars (2 and 3) and engagement went 6.0 → 6.67 → 7.22. The counters are for the
   page, the panel is for the reader, and they measure different things.
2. **A per-chapter prompt is a template.** The scene call on every chapter cost 0.7 on slop resistance in rung 3;
   rotating it bought most of that back in rung 5. Whatever the next lever is, assign it to some chapters, not all.
3. **Wikimedia is a thirty-a-minute host.** The throttle, back-off, contact user-agent and dossier budget are
   the difference between a dossier and three archive.org documents.
4. **The quote guard works as a measurement and as a veto.** 33 of 43 quoted spans on rung 5 were verbatim in the
   dossier; the one or two a book hung on a dossier document without being in it lost their marks. The rest are
   the writer's own (creative contract), counted and left.
5. **Pacing has not moved in any rung** (5.7 → 6.1). It is the criterion left; the readers' words for it are
   length, the paired-case machine and the recap tail, which no lever here touched.

## Round 3 (commits 7d35874, 70d9c7d): opinion-fable-6's first experiment, ladder-8

Two arms of three books, 2026-09-04. Arm A = rung 5's flags with `chapterExits`, `repetitionCut` and the line
editor's extension off (`editorExtension`, a new flag). Arm B = A plus `toldClosings`: up to five chapters that do
not open on a scene get their last section told by the scene call from their own episode. Also landed:
deterministic episode ownership and an OCR filter on epigraphs.

| arm | books | overall | engagement | pacing | slop | eng+slop | extension | scenes | closings | $ |
|---|---|---|---|---|---|---|---|---|---|---|
| A: extension off | 7.27 / 7.77 / 7.53 | 7.52 | 6.78 | 6.0 | 6.56 | 13.34 | 0 of 15 asked, −10 to −14% from the edit | 3–4 | 0 | 0.40–0.44 |
| B: + told closings | 7.87 / 7.47 / 7.40 | 7.58 | 6.44 | 6.0 | 6.33 | 12.77 | 0 of 15 | 2–3 | 3–5 | 0.39–0.44 |

**Pre-registered pass for B** (extension ≤ 2%, five closings, engagement ≥ 7.0, slop ≥ 6.8): the counts pass and
the panel does not. Engagement 6.44 and slop 6.33 are both below arm A; the readers of 8Bb named "cinematic
present-tense-feeling vignettes with invented sensory detail bolted to the end" as a pattern — a told section
appended to a chapter reads as bolted on, the way the exits read as stubs. **Pairwise on the closing chapters** (A
against B, both orders): chapter 6 to B in both orders, chapter 9 to A in both — one each, position-consistent.
The eng+slop sum stays on the plateau (13.3) in A and falls off it downward in B.

**Two failures and a fix.** 8Aa and 8Ba failed at chapter 6/7 on the degeneracy guard's foreign-script rule: four
and five Arabic characters (بالله) the writer quoted under the creative contract. The ceiling was two, set when no
shipped chapter carried any; it is now a run of forty (70d9c7d) and both books were retried from their staged
chapters. A separate product note: with the extension off the books run 96–126 printed pages for 120 paid
(8Aa 96), because the compose ask is corrected for the writer's 87% delivery only on told chapters; correcting it
everywhere is a one-line change the implementer left out on purpose. The balanced tier is left with the extension
back on for that reason, exits, closings and the repetition cut off (revision 46).

**The instrument, re-measured.** composed-7 (project cmtjlkn0z0000g8g08zbzxerc, the plan every rung reuses) was
read again by three fresh readers in the same sitting as ladder-8: **7.07** (7.1 / 7.0 / 7.1, engagement 6.0,
slop 6.33) against **7.73** (7.7 / 7.7 / 7.8) from the same rubric on 2026-09-02. Same book, same model, same
rubric, 0.66 apart between sittings. Cross-day comparisons in this report — every rung against the 7.46 baseline
— carry that drift; within-sitting comparisons do not. In the same sitting: composed-7 7.07 against arm A 7.52 and
arm B 7.58 (+0.45 to +0.5), engagement 6.0 against 6.78, quotations 2 against ~20, proper nouns per thousand 13.7
against 19.6; pairwise on chapter 1, arm A over composed-7 in both orders; on chapter 8, order-dependent (a tie).

## Round 2 (commit 5c93566): assigned exits, the scene form capped, the repetition cut

### Rung 6 — counts first (the plan's pre-registered readouts), panel pending
| count | prediction | measured (6a / 6b / 6c) |
|---|---|---|
| scene calls | ≤ 5 of 15, none consecutive | 2 / 2 / 3 (was 7–8 on rung 5, 13–15 on rung 3) |
| assigned `landing` exits | 5 of 15 | 5 / 5 / 5 |
| chapters ending authorial, exit-aware | ≤ 5 | 0 / 3 / 1 (corpus reading of rung 5: 11–15 of 15) |
| landing pasted on the five `landing` chapters | high (plan item 1) | **5 / 5 / 5** — the planner's sentence reached the prose on every landing chapter |
| epigraph excerpt = exit excerpt | > 0 (plan item 2) | 1 / 2 / 1 chapters open and close on the same document |
| repetition cut | 0 calls | 0 flagged, 0 cut on all three |
| couplets /1000 | — | 5.3 / 6.7 / 4.9 |
| quotations | — | 18 / 41 / 22; guard 11/12, 20/28, 9/10 verbatim |
| cost, minutes | — | $0.39–0.41, 26–33 min |

**Panel, nine readers:** 7.58 (7.97 / 7.60 / 7.17 — 6a is the best single book of the programme and 6c the
weakest since rung 4), engagement 6.56, pacing 5.89, slop resistance **7.0**, the highest of any rung (rung 5: 6.44).
Seven of nine verdicts still name a closing aphorism among the patterns; two name a closing question.
**Pairwise against rung 5b** on fixed chapters, both orders: chapter 1 to rung 6 in both orders, chapter 8 to rung 5
in both — position-consistent, split. Engagement fell from 7.0 toward rung 2's 6.67 with the scene calls at 2–3 a
book, which is the plan's own pre-registered reading: the scene was carrying engagement, and the next content
assignment goes to the chapters the scene does not reach (openings as a payload), not back to more scenes.

Both predictions in `plan-5c93566-amendments.md` held, which is why the amendments are being built for
rung 7: the `landing` exit re-opened the door the silent plan had closed (five chapters a book now end on
the planner's sentence, verbatim or near it), and the epigraph and the excerpt exit pick the same excerpt.

### Rung 7 — the amendments, measured
Counts first: the landing is no longer pasted (0 of 5 landing chapters a book, was 5 of 5); no chapter opens and
closes on the same document (was 1–2); person exits 0 (no excerpt named the person, so the rotation fell to
`date`: 6–7 date exits a book); landings at chapters 1, 4/5, 8, 11, 15; scene calls 3–4; repetition cut 0 calls;
couplets 6–8. 7a ended in `REVIEW_REQUIRED` because the compile audit's prompt-leak scanner fired on "the plan" in
a chapter about the *Brookes* deck plan — a false positive on legitimate prose, the kind the drafting gotchas say
to remove rather than tune.

Panel, nine readers: 7.32 (7.60 / 7.17 / 7.20), engagement 6.33, pacing 5.78, slop resistance 6.33 — down from
rung 6's 7.58 / 6.56 / 7.0, inside the noise band on the mean but with a pattern the readers had not named before:
"chapter-ending appended fact or quotation that breaks the argumentative voice, often reading like a stub rather
than a conclusion"; "every chapter closes with a flat recapitulation sentence that restates a source and its
bibliographic particulars". Eight of nine verdicts name a closer, six a closing question. The exit line that says
"the final sentence of the chapter is that material itself … then silence" is performed as a citation stub — a
shape rule performed on schedule, the programme's oldest lesson, this time at the exit. Pairwise against 5b:
chapter 1 to rung 7 in both orders, chapter 8 to 5b in both — the same split as rung 6, and the readers' reasons
are the same words: 5b's chapter 8 opens inside the Zong as a scene and the capped pipeline's does not.

**Where this leaves the pipeline.** The counts say the amendments did what the plan asked; the panel says the
exit, as prompted, reads as a stub, and the scene cap cost the chapters that used to open on one. The best
measured state remains rung 5 (7.74, engagement 7.0), and the committed scene cap means that exact state no
longer exists in the code: with `chapterExits` off, the pipeline is rung 5's flags on capped scenes, unmeasured.
Two ways forward, both cheap: (a) keep the exits but change the one line — end *inside* the material rather than
set it down last, and let the epigraph carry the citation; (b) put material on the openings of the ~10 chapters
the scene call no longer reaches (the plan's out-of-scope rung), since both pairwise splits say the opening scene
is what chapter 8's readers paid for. The pipeline is left at rung 7's flags (quality revision 39); `dev-set-quality.ts
feature chapterExits balanced off` gives (a)'s baseline, `restore 37` rung 5's flags.

## Pairwise, position-swapped, on fixed chapters (baseline 23a against rung 5b)
Chapters 1 and 8, each pair read in both orders by an Opus reader asked only which version is more engaging and
which is better paced, no ties. Eight votes, eight for rung 5 — both chapters, both orders, both criteria. The
absolute panel's +0.3 on the mean is, on fixed chapters, a clean sweep. The packets for two human readers are in
`human-packets/` with a one-question protocol (the put-down paragraph).

## Typesetting, measured and not shipped
The page is A4 at 11pt / 1.55 leading with 20/18/22 mm margins, about 490 words a printed page. The candidate
(12pt / 1.62) renders the same 50,309-word book at 129 pages against 103, about 390 words a page, and the fixture
corpus drifts on six of eight fixtures (`pnpm render:fixtures --compare`). Page 30 of both renders is in the session
`typesetting/` folder beside this report (`page30-11pt-before.png`, `page30-12pt-after.png`): both are dense A4 text blocks; the larger type
helps less than a smaller page would. Shipping it means every pipeline's words-per-page budget moves with it (the
composed budget from 520 to about 450 a page to keep 120 paid pages printing as 120) and the recorded page counts
and stylesheet digests in `pdf.test.ts` / `pdfDocument.test.ts` are re-baselined — a product decision about words
per paid page, left to Parsa. The apparatus half (an attributed epigraph from the dossier at each chapter head) is
built behind `chapterApparatus` and measured as rung 5.
