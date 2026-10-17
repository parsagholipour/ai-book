# Rubric — whole-book excerpt

`A.md` and `B.md` are the same stretch of a book (several pages or chapters) in two versions. Judge them as a
reader of the whole book would meet them.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **coherence** — plot causality and continuity (fiction) or internal logic and progression (nonfiction);
   nothing contradicts what came before.
2. **pacing** — progression without recap, restatement or repeated caveats; transitions that carry the reader.
3. **prose** — clarity, voice and sentence craft; natural dialogue; reads aloud well where it should.
4. **brief** — delivers what `brief.txt` promises for this stretch (content, audience, tone).
5. **defects** — the version with fewer reader-visible defects: production notes, prompt language, placeholders,
   duplicated passages, wrong arithmetic, truncation, broken formatting.

Then the **overall** preference: the version you would publish. A clear defect outweighs a stylistic edge.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "coherence": "A|B|tie", "pacing": "A|B|tie", "prose": "A|B|tie", "brief": "A|B|tie", "defects": "A|B|tie" },
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["…"],
  "defectsB": ["…"]
}
