#!/usr/bin/env python3
"""Blind completed books for independent Sol readers, the way ../2026-09-05-sol did it.

    python3 blind-books.py <label> [<label> ...]

Each label names a completed export under docs/composed-chapters/runs/<label>/book.md. The manuscript is copied
byte for byte to blind/<CODE>/manuscript.txt under a fresh two-character code that no earlier assessment used,
evals/<CODE>/ is created for the readers' verdicts, and manifest.json gains a `candidates` entry with the
sha256 and word count summarize.py validates. Labels already blinded are skipped, never re-coded.
"""
import hashlib, json, os, random, re, sys

here = os.path.dirname(os.path.abspath(__file__))
runs = os.path.normpath(os.path.join(here, "..", "..", "runs"))
manifest_path = os.path.join(here, "manifest.json")
manifest = json.load(open(manifest_path))
candidates = manifest.setdefault("candidates", {})
used = set(candidates) | {"J4", "M8", "Q9", "T2"}
for label in sys.argv[1:]:
    if any(entry["sourceLabel"] == label for entry in candidates.values()):
        print(f"{label}: already blinded"); continue
    book = os.path.join(runs, label, "book.md")
    data = open(book, "rb").read()
    text = data.decode("utf8")
    if not re.search(r"^## Chapter \d+: ", text, re.M):
        raise SystemExit(f"{label}: book.md carries no chapter headings; refusing to blind an incomplete export")
    rng = random.SystemRandom()
    while True:
        code = rng.choice("BDFGHJKLMNPQRSTVWXZ") + rng.choice("2345678")
        if code not in used: break
    used.add(code)
    os.makedirs(os.path.join(here, "blind", code), exist_ok=True)
    os.makedirs(os.path.join(here, "evals", code), exist_ok=True)
    with open(os.path.join(here, "blind", code, "manuscript.txt"), "wb") as handle:
        handle.write(data)
    candidates[code] = {"sourceLabel": label, "arm": "development", "sha256": hashlib.sha256(data).hexdigest(), "words": len(text.split())}
    print(json.dumps({"code": code, **candidates[code]}))
json.dump(manifest, open(manifest_path, "w"), indent=1)
open(manifest_path, "a").write("\n")
