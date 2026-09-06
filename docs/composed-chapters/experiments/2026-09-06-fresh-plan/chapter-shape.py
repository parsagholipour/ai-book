#!/usr/bin/env python3
"""Per-chapter shape of an exported book.md: words, paragraphs, opening sentence, closing sentences.

    python3 chapter-shape.py <book.md> [--closings N]

The readout the summary's third step asks for: does the outline actually vary length, and do chapters
still close on the same institutional sentence. Prints one block per chapter and a closing-sentence list.
"""
import re, sys

path = sys.argv[1]
closings = int(sys.argv[sys.argv.index("--closings") + 1]) if "--closings" in sys.argv else 2
text = open(path, encoding="utf8").read()
parts = re.split(r"^## (Chapter \d+: .+)$", text, flags=re.M)
chapters = [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]

def sentences(paragraph):
    return [s.strip() for s in re.split(r"(?<=[.!?…”\"])\s+(?=[A-Z“\"(])", paragraph.strip()) if s.strip()]

rows = []
for title, body in chapters:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip() and not p.strip().startswith("```") and not p.strip().startswith("![")]
    prose = [p for p in paragraphs if not p.startswith("#") and not p.startswith(">") and not p.startswith("|")]
    words = sum(len(p.split()) for p in prose)
    first = sentences(prose[0])[0] if prose else ""
    last = sentences(prose[-1])[-closings:] if prose else []
    plens = [len(p.split()) for p in prose]
    rows.append((title, words, len(prose), first, last, plens))

print(f"{'chapter':<64}{'words':>7}{'paras':>7}{'mean p':>8}{'max p':>7}")
for title, words, n, first, last, plens in rows:
    mean = sum(plens) / len(plens) if plens else 0
    print(f"{title[:63]:<64}{words:>7}{n:>7}{mean:>8.0f}{max(plens) if plens else 0:>7}")
total = sum(r[1] for r in rows)
print(f"\ntotal words {total}; chapter word range {min(r[1] for r in rows)}–{max(r[1] for r in rows)}")

print("\n== openings ==")
for title, words, n, first, last, plens in rows:
    print(f"{title[:40]:<41} {first[:200]}")

print("\n== closings ==")
for title, words, n, first, last, plens in rows:
    print(f"{title[:40]:<41} {' '.join(last)[:400]}")
