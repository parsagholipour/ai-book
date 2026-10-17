# Rubric — chapter

Judge which chapter a reader who bought this book would rather read, as finished prose in this book.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **engagement** — people, scenes, voices and particulars on the page; an argument or story that moves;
   something the reader did not expect. Would the reader keep reading?
2. **clarity** — sentences a reader understands on first reading; claims stated plainly; no muddle.
3. **repetition** — less restatement, recap, repeated caveats and sentences that say what the previous one
   showed; nothing that repeats the neighbouring chapter's edges in `context.md`. The better version is the
   one with *less* needless repetition.
4. **hedging** — fewer reflexive qualifications and symmetrical both-sides moves that add no information
   (a real, specific uncertainty stated once is not hedging). The better version hedges *less needlessly*.
5. **fidelity** — keeps to the brief and to what the book is; invents no unsupported specifics; no production
   notes, notes-language ("the research brief", "the supplied figures"), word-count talk or placeholders.

Then give the **overall** preference: the chapter you would print. A clear defect (a production note in the
prose, a broken or truncated ending, a duplicated passage, an invented quotation presented as a source)
outweighs a stylistic edge.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "engagement": "A|B|tie", "clarity": "A|B|tie", "repetition": "A|B|tie", "hedging": "A|B|tie", "fidelity": "A|B|tie" },
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["short description of each clear defect in A, if any"],
  "defectsB": ["short description of each clear defect in B, if any"]
}
