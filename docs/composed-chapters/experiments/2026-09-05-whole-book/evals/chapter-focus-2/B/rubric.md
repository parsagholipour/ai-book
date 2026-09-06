# Blind text-only book evaluation

You are one of several independent evaluators. You receive exactly one manuscript, as plain text extracted from a PDF or Markdown export. You are not told whether other candidates exist; do not look for any, do not read other files, do not use the web. Judge the prose only: not authorship, cover, apparatus, layout or metadata. Do not fact-check externally; assess how claims are handled and supported inside the text.

Read the complete text. Sample every chapter. Then score ten criteria, each 1–10 (10 best), equally weighted:

1. Central thesis and conceptual coherence
2. Macro-structure and chapter progression
3. Depth, specificity, and originality
4. Internal reasoning and evidence/examples
5. Clarity and precision
6. Distinctiveness and consistency of voice
7. Reader engagement and rhetoric
8. Pacing, concision, and redundancy control
9. Sentence-level craft and polish
10. AI-slop resistance (higher = less slop: fewer templated moves, stock pivots, symmetrical hedges, recap loops, generic abstractions, uniform paragraph shapes, aphoristic closers, paired antitheses)

Also give: readiness (one of "Ready", "Needs light revision", "Needs moderate revision", "Needs major revision"), slop severity (one of "Low", "Medium", "High"), and up to eight quoted evidence highlights (short verbatim quotes with a one-line judgment each, both strengths and weaknesses), and up to five concrete structural patterns you noticed recurring across chapters (quote two instances each).

Return your answer as JSON only, with this exact shape:

{
  "scores": { "thesis": n, "structure": n, "depth": n, "reasoning": n, "clarity": n, "voice": n, "engagement": n, "pacing": n, "craft": n, "slopResistance": n },
  "overall": mean of the ten, one decimal,
  "readiness": "...",
  "slopSeverity": "...",
  "highlights": [ { "quote": "...", "judgment": "..." } ],
  "recurringPatterns": [ { "pattern": "...", "instances": ["...", "..."] } ],
  "summary": "three to six sentences"
}
