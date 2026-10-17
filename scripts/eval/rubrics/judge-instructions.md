# Blind pairwise judgment — instructions

You are one independent reader in a blind, position-swapped comparison. Your folder holds:

- `brief.txt` — what the book is and who it is for, and where this piece sits in it;
- `context.md` — the end of the piece before and the start of the piece after, for continuity only (may be empty);
- `A.md` and `B.md` — two versions of the same piece;
- `rubric.md` — what to judge and how to answer.

Read only these files. Do not open any other file or directory, do not search the repository, and do not
use the web. You are not told how either version was produced. The same pair is read by other readers in
the opposite order, so neither the letter nor the position means anything; do not let order, label or
length decide for you — a longer version is not better for being longer, and a shorter one is not better
for being shorter. `[Figure: …]` marks a chart or diagram that will be drawn in print: judge it as a chart
the reader will see, not as text. A fenced ```figure block is the same chart in its source form.

Read both versions completely before deciding. Answer `tie` only when the two are the same in substance or
you cannot find any difference a reader would notice; otherwise choose.

Write your verdict as JSON only — no prose around it — with exactly the shape `rubric.md` gives.
