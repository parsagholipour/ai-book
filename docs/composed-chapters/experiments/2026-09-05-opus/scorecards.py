#!/usr/bin/env python3
"""Side-by-side deterministic scorecards (runs/<label>/scorecard.txt) for every blinded book, as a Markdown table."""
import json, os, re
here = os.path.dirname(os.path.abspath(__file__))
runs = os.path.normpath(os.path.join(here, "..", "..", "runs"))
manifest = json.load(open(os.path.join(here, "manifest.json")))
order = {"new": 0, "baseline": 1, "reference": 2}
labels = [c["sourceLabel"] for c in sorted(manifest["candidates"].values(), key=lambda c: (order.get(c["arm"], 9), c["sourceLabel"]))]
rows = ["words", "coupletsPer1000Sentences", "negationContrastPer1000Sentences", "listSentenceShare", "generalisingCloserShare", "hedgeEndingShare", "sentenceCv", "paragraphCv", "top5ShapeCoverage"]
cards = {}
for label in labels:
    path = os.path.join(runs, label, "scorecard.txt")
    if not os.path.exists(path):
        continue
    card = {}
    for line in open(path):
        m = re.match(r"^(\w+)\s+(.+?)\s*$", line)
        if m and re.match(r"^-?[\d.]+$", m.group(2)):
            card[m.group(1)] = float(m.group(2))
    cards[label] = card
print("| measure | " + " | ".join(cards) + " |")
print("|---|" + "---:|" * len(cards))
for row in rows:
    cells = []
    for label in cards:
        v = cards[label].get(row)
        cells.append("–" if v is None else (f"{v:,.0f}" if row == "words" else f"{v:.3f}" if v < 1 else f"{v:.1f}"))
    print(f"| {row} | " + " | ".join(cells) + " |")
