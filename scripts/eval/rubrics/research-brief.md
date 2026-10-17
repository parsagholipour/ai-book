# Rubric — research brief

`A.md` and `B.md` are two research briefs a writer will be handed for the chapter described in `brief.txt`.
The writer may use only what the brief gives them. Judge which brief would let them write the better, more
accurate chapter.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **relevance** — about this chapter's subject and leads, not the book in general.
2. **specificity** — named people, documents, dates, places, numbers and short quotations a writer can use.
3. **coverage** — covers every lead or question the chapter needs, not one of them at length.
4. **reliability** — claims attributed to identifiable sources; uncertainty marked where the sources disagree;
   nothing that reads as invented.
5. **usability** — organized so a writer can find things; no padding.

Then the **overall** preference.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "relevance": "A|B|tie", "specificity": "A|B|tie", "coverage": "A|B|tie", "reliability": "A|B|tie", "usability": "A|B|tie" },
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["…"],
  "defectsB": ["…"]
}
