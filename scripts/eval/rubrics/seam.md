# Rubric — chapter seam

`A.md` and `B.md` each show the same turn in a book: the last paragraphs of one chapter, then the first paragraphs
of the next. **The end of the earlier chapter is identical in both**; only the start of the next chapter differs.
Judge the turn as a reader moving from one chapter to the next meets it.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **fresh** — the new chapter opens on its own material; it does not resume, summarise, answer, re-describe or
   repeat how the earlier chapter just ended.
2. **continuity** — the new chapter is consistent with what the earlier chapter just said: the same people in the
   same roles and relations, the same facts, figures and situation; nothing it says contradicts the ending above it.
3. **transition** — the turn reads naturally: the opening neither ignores where the story or argument now stands
   in a way that jars, nor leans on the previous ending.
4. **prose** — clarity, voice and sentence craft of the new chapter's opening.

Then the **overall** preference: the opening you would publish after that ending. A contradiction of the ending, or
a re-telling of it, outweighs a stylistic edge.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "fresh": "A|B|tie", "continuity": "A|B|tie", "transition": "A|B|tie", "prose": "A|B|tie" },
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["…"],
  "defectsB": ["…"]
}
