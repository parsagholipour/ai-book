# Rubric — fiction chapter, with a continuity score

Judge which chapter a reader who bought this book would rather read, as finished prose in this book.

`material.md` is what the writer was given for this chapter: the book's premise, style notes and continuity rules,
this chapter's summary and section plan, the cast, the facts earlier chapters established, continuity notes, the
story's open threads, and digests of the chapters before. `context.md` holds the end of the chapter before (and the
start of the next, when there is one). This is fiction: invented people, places and details are the writer's job and
are never a fault in themselves. What matters is whether the chapter stays **consistent** with what the book has
already fixed, and whether it **delivers this chapter's plan**.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **engagement** — scenes, voices and particulars on the page; a story that moves; something the reader did not
   expect. Would the reader keep reading?
2. **clarity** — sentences a reader understands on first reading; who is where, doing what, is never muddled.
3. **repetition** — less restatement, recap and sentences that say what the previous one showed; nothing that
   re-tells the previous chapter's ending in `context.md`. The better version repeats *less* needlessly.
4. **hedging** — fewer reflexive qualifications and explained-away moments; scenes that end on action, speech or an
   image rather than on what they meant. The better version hedges *less needlessly*.
5. **continuity** — the version that better keeps to what the book has fixed and to this chapter's plan:
   - no contradiction of the cast (a name, role, relation, pronoun or age), the established facts, the earlier
     chapters' events or the previous chapter's ending — unless the chapter itself shows the change happening;
   - delivers the chapter summary and the planned sections in their order and forms (a planned scene dramatised, a
     planned confrontation actually happening), without skipping one;
   - keeps the book's premise, tone and continuity rules; no plan language in the prose ("this chapter", "section",
     "the reader will"), no headings or labels where the book asks for prose, no production notes.

Score each version's continuity on its own, 1–5: 5 = consistent with everything in the material and delivers the
plan; 4 = one minor slip (a small detail at odds with the material, or one section thin); 3 = a few slips, or one
that a reader would notice (a renamed person, a changed relation, an event told differently from before, a planned
section missing); 2 = several noticeable contradictions or the plan largely ignored; 1 = the chapter does not fit this
book at this point.

List, for each version, the contradictions you found (quote a few words of the chapter and say what it contradicts)
and the plan misses (which planned section or summary point is skipped or changed). Leave a list empty when there are
none.

Then give the **overall** preference: the chapter you would print. A clear defect (a contradiction a reader would
notice, a production note in the prose, a broken or truncated ending, a duplicated passage) outweighs a stylistic
edge.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "engagement": "A|B|tie", "clarity": "A|B|tie", "repetition": "A|B|tie", "hedging": "A|B|tie", "continuity": "A|B|tie" },
  "continuityScore": { "A": 1-5, "B": 1-5 },
  "contradictionsA": ["each contradiction in A: quote briefly, then what it contradicts"],
  "contradictionsB": ["each contradiction in B: quote briefly, then what it contradicts"],
  "planMissesA": ["each planned section or summary point A skips or changes"],
  "planMissesB": ["each planned section or summary point B skips or changes"],
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["short description of each clear defect in A, if any"],
  "defectsB": ["short description of each clear defect in B, if any"]
}
