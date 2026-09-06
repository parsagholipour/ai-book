"""Summarize per-job live evidence calls; never assign a literary score to a failure."""
from collections import Counter
from datetime import datetime
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
manifest = json.loads((ROOT / 'manifest.json').read_text())

for launch in manifest['launches']:
    log = REPO / 'storage' / 'books' / launch['projectId'] / 'runs' / f"{launch['generationJobId']}-generate-book.jsonl"
    events = [json.loads(line) for line in log.read_text().splitlines()]
    requests = {event['callId']: event for event in events if 'request' in event and 'callId' in event}
    calls = Counter(event['request'].get('purpose', event['event']) for event in requests.values())
    errors = []
    reviews = []
    plans = []
    for event in events:
        request = requests.get(event.get('callId'), {}).get('request', {})
        purpose = request.get('purpose')
        if event['event'] == 'text.generateJson.error':
            error = event.get('error', {})
            errors.append({'purpose': purpose, 'timestamp': event['timestamp'], 'error': error})
        if event['event'] != 'text.generateJson.response':
            continue
        data = event['result'].get('data')
        if purpose == 'plan-episodes':
            plans.append({'timestamp': event['timestamp'], 'data': data})
        if purpose == 'verify-case-evidence':
            packet = json.loads(request['messages'][-1]['content'])
            packet.pop('outputContract', None)
            packet.pop('outputInstructions', None)
            ids = [claim['id'] for claim in data['claims']]
            expected = [claim['id'] for claim in packet['claims']]
            complete = len(set(ids)) == len(ids) == len(expected) and set(ids) == set(expected)
            accepted = complete and all(claim['supported'] for claim in data['claims']) and all(data[key] for key in ['relevant', 'sequenceSupported', 'disagreementsSupported', 'unknownsAccurate'])
            reviews.append({'timestamp': event['timestamp'], 'packet': packet, 'verdict': data, 'acceptedByReview': accepted})
    failed = next((event for event in reversed(events) if event['event'] == 'job.failed'), None)
    parse_time = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
    diagnostic = {
        'label': launch['label'], 'generationJobId': launch['generationJobId'],
        'startedAt': events[0]['timestamp'], 'lastEventAt': events[-1]['timestamp'],
        'elapsedMinutes': (parse_time(events[-1]['timestamp']) - parse_time(events[0]['timestamp'])).total_seconds() / 60,
        'eventCounts': dict(Counter(event['event'] for event in events)), 'requestCounts': dict(calls),
        'errorCounts': dict(Counter(error['purpose'] for error in errors)),
        'reviewCount': len(reviews), 'acceptedReviewCount': sum(review['acceptedByReview'] for review in reviews),
        'chaptersWithAcceptedReviews': sorted({review['packet']['sourceChapterIndex'] for review in reviews if review['acceptedByReview']}),
        'failure': failed, 'errors': errors, 'reviews': reviews, 'episodePlans': plans,
    }
    (ROOT / 'diagnostics' / f"{launch['label']}.json").write_text(json.dumps(diagnostic, indent=2) + '\n')
    print(json.dumps({key: value for key, value in diagnostic.items() if key not in ['failure', 'errors', 'reviews', 'episodePlans']}, indent=2))
