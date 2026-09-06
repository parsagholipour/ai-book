#!/usr/bin/env python3
"""Print the report's Markdown tables from summary.json (run summarize.py first)."""
import json
from pathlib import Path
s = json.loads((Path(__file__).resolve().parent / 'summary.json').read_text())
KEYS = ['thesis', 'structure', 'depth', 'reasoning', 'clarity', 'voice', 'engagement', 'pacing', 'craft', 'slopResistance']
LABEL = {'thesis': 'Thesis', 'structure': 'Structure', 'depth': 'Depth', 'reasoning': 'Reasoning/evidence', 'clarity': 'Clarity', 'voice': 'Voice', 'engagement': 'Engagement', 'pacing': 'Pacing', 'craft': 'Craft', 'slopResistance': 'Slop resistance'}
order = {'new': 0, 'baseline': 1, 'reference': 2}
books = sorted(s['books'], key=lambda b: (order.get(b['arm'], 9), b['sourceLabel']))
print('| Book | Arm | Words | Reader A | Reader B | Reader C | Mean | Engagement | Pacing | Slop res. |')
print('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for b in books:
    r = {x['reader']: x['overall'] for x in b['readers']}
    cells = [f"{r.get(k, float('nan')):.1f}" if k in r else '–' for k in 'ABC']
    print(f"| {b['sourceLabel']} | {b['arm']} | {b['words']:,} | {' | '.join(cells)} | **{b['means']['overall']:.2f}** | {b['means']['engagement']:.2f} | {b['means']['pacing']:.2f} | {b['means']['slopResistance']:.2f} |")
arms = [a for a in ['new', 'baseline', 'reference'] if a in s['arms']]
print()
print('| Criterion | ' + ' | '.join(f"{a} ({s['arms'][a]['completeBooks']} book{'s' if s['arms'][a]['completeBooks'] != 1 else ''})" for a in arms) + (' | new − baseline |' if 'new' in arms and 'baseline' in arms else ' |'))
print('|---|' + '---:|' * (len(arms) + (1 if 'new' in arms and 'baseline' in arms else 0)))
for k in ['overall', *KEYS]:
    row = [f"{s['arms'][a]['means'][k]:.2f}" for a in arms]
    if 'new' in arms and 'baseline' in arms:
        d = s['arms']['new']['means'][k] - s['arms']['baseline']['means'][k]
        row.append(f"{d:+.2f}")
    print(f"| {'**Overall**' if k == 'overall' else LABEL[k]} | " + ' | '.join(row) + ' |')
