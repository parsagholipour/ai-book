"""Validate blind verdicts and summarize book means without treating readers as replicates."""
from pathlib import Path
import hashlib
import json
import statistics
import re

ROOT = Path(__file__).resolve().parent
KEYS = ['thesis', 'structure', 'depth', 'reasoning', 'clarity', 'voice', 'engagement', 'pacing', 'craft', 'slopResistance']
manifest = json.loads((ROOT / 'manifest.json').read_text())
books = []
issues = []
for code, candidate in manifest['candidates'].items():
    manuscript_path = ROOT / 'blind' / code / 'manuscript.txt'
    if not manuscript_path.exists():
        continue
    manuscript = manuscript_path.read_text()
    if hashlib.sha256(manuscript_path.read_bytes()).hexdigest() != candidate['sha256']:
        issues.append(f'{code}: manuscript changed after blinding')
    if len(manuscript.split()) != candidate['words']:
        issues.append(f'{code}: manifest word count does not match manuscript')
    titles = re.findall(r'^## (Chapter \d+: .+)$', manuscript, re.M)
    normalize_title = lambda title: re.sub(r'^Chapter \d+:\s*', '', title).strip()
    readers = []
    for reader in 'ABC':
        path = ROOT / 'evals' / code / reader / 'verdict.json'
        if not path.exists():
            continue
        verdict = json.loads(path.read_text())
        if set(verdict['scores']) != set(KEYS):
            issues.append(f'{code}/{reader}: wrong score keys')
            continue
        if any(not isinstance(verdict['scores'][key], (int, float)) or not 1 <= verdict['scores'][key] <= 10 for key in KEYS):
            issues.append(f'{code}/{reader}: scores out of range')
            continue
        mean = statistics.mean(verdict['scores'][key] for key in KEYS)
        if abs(verdict['overall'] - mean) > .051:
            issues.append(f'{code}/{reader}: overall does not equal rounded criterion mean')
        quotes = [item['quote'] for item in verdict.get('highlights', [])]
        quotes += [quote for item in verdict.get('recurringPatterns', []) for quote in item.get('instances', [])]
        for quote in quotes:
            if quote not in manuscript:
                issues.append(f'{code}/{reader}: quote absent: {quote[:100]}')
        coverage = ROOT / 'evals' / code / reader / 'coverage.json'
        if not coverage.exists():
            issues.append(f'{code}/{reader}: missing reading coverage')
        else:
            record = json.loads(coverage.read_text())
            reported_words = record.get('totalWordCount', record.get('totalManuscriptWordCount'))
            reported_titles = next((record[key] for key in ['chapterTitlesRead', 'chaptersRead', 'chapterTitles'] if key in record), [])
            if reported_words != candidate['words']:
                issues.append(f'{code}/{reader}: reading coverage word count mismatch')
            if not titles or [normalize_title(title) for title in reported_titles] != [normalize_title(title) for title in titles]:
                issues.append(f'{code}/{reader}: reading coverage chapter list mismatch')
            if record.get('chapterCount', len(titles)) != len(titles):
                issues.append(f'{code}/{reader}: reading coverage chapter count mismatch')
        readers.append({'reader': reader, 'overall': mean, **verdict['scores']})
    if not readers:
        continue
    books.append({'code': code, **candidate, 'readers': readers, 'readerCount': len(readers),
                  'means': {key: statistics.mean(r[key] for r in readers) for key in ['overall', *KEYS]},
                  'readerRange': [min(r['overall'] for r in readers), max(r['overall'] for r in readers)]})

arms = {}
for arm in dict.fromkeys(book['arm'] for book in books):
    group = [book for book in books if book['arm'] == arm and book['readerCount'] == 3]
    if group:
        arms[arm] = {'completeBooks': len(group), 'means': {key: statistics.mean(b['means'][key] for b in group) for key in ['overall', *KEYS]},
                     'bookRange': [min(b['means']['overall'] for b in group), max(b['means']['overall'] for b in group)],
                     'bookStandardDeviation': statistics.stdev(b['means']['overall'] for b in group) if len(group) > 1 else None}
summary = {'assessorModel': manifest['assessorModel'], 'books': books, 'arms': arms, 'validationIssues': issues}
if 'baseline' in arms and 'new' in arms:
    summary['newMinusBaseline'] = {key: arms['new']['means'][key] - arms['baseline']['means'][key] for key in ['overall', *KEYS]}
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('Book | readers | overall | engagement | pacing | structure | slop resistance')
for book in books:
    values = [f"{book['means'][key]:.2f}" for key in ['overall', 'engagement', 'pacing', 'structure', 'slopResistance']]
    print(' | '.join([book['sourceLabel'], str(book['readerCount']), *values]))
print(json.dumps({'arms': arms, 'issues': issues}, indent=2))
if issues:
    raise SystemExit(1)
