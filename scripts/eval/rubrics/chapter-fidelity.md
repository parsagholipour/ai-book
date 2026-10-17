# Rubric — chapter, with a fidelity score

Judge which chapter a reader who bought this book would rather read, as finished prose in this book.

If your folder holds `material.md`, it is what the writer was given for this chapter: the section plan, research
notes, source passages, episodes, facts, what earlier chapters told the reader, and cases that belong to other
chapters. Use it to check fidelity. A specific the chapter adds from general knowledge is not wrong for being absent
from the material, but a quotation presented as a real person's or document's words that is not in the material,
or a named person, organisation, date, statistic or study presented as fact that you are not confident is true, is
an unsupported specific.

For each dimension, name the better version (`"A"`, `"B"` or `"tie"`):

1. **engagement** — people, scenes, voices and particulars on the page; an argument or story that moves;
   something the reader did not expect. Would the reader keep reading?
2. **clarity** — sentences a reader understands on first reading; claims stated plainly; no muddle.
3. **repetition** — less restatement, recap, repeated caveats and sentences that say what the previous one
   showed; nothing that repeats the neighbouring chapter's edges in `context.md`. The better version is the
   one with *less* needless repetition.
4. **hedging** — fewer reflexive qualifications and symmetrical both-sides moves that add no information
   (a real, specific uncertainty stated once is not hedging). The better version hedges *less needlessly*.
5. **fidelity** — keeps to the brief and to what the book is; invents no unsupported specifics (check them against
   `material.md` when there is one); no production notes, notes-language ("the research brief", "the supplied
   figures"), word-count talk or placeholders.

Score each version's fidelity on its own, 1–5: 5 = every quotation and specific is supported or plainly safe
general knowledge; 4 = one doubtful minor specific; 3 = a few doubtful specifics, or one that matters; 2 = an
invented quotation or several unsupported specifics presented as fact; 1 = the chapter leans on invented material.

List, for each version, the unsupported specifics you found (quotation, named person, organisation, date,
statistic, study): a few words each, quoting the chapter. Leave the list empty when there are none.

Then give the **overall** preference: the chapter you would print. A clear defect (a production note in the
prose, a broken or truncated ending, a duplicated passage, an invented quotation presented as a source)
outweighs a stylistic edge.

Return JSON only:

{
  "preferred": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "dimensions": { "engagement": "A|B|tie", "clarity": "A|B|tie", "repetition": "A|B|tie", "hedging": "A|B|tie", "fidelity": "A|B|tie" },
  "fidelityScore": { "A": 1-5, "B": 1-5 },
  "inventedA": ["each unsupported specific in A, quoted briefly"],
  "inventedB": ["each unsupported specific in B, quoted briefly"],
  "reason": "two or three sentences, quoting a few words from each version",
  "defectsA": ["short description of each clear defect in A, if any"],
  "defectsB": ["short description of each clear defect in B, if any"]
}
