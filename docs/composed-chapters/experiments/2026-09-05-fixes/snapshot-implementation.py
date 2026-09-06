#!/usr/bin/env python3
"""Freeze the implementation under test: sha256 of every dirty source file plus a tarball of them.

    python3 docs/composed-chapters/experiments/2026-09-05-fixes/snapshot-implementation.py implementation-3

Selection is `git status --porcelain` (modified, added, untracked) restricted to apps/, packages/ and
scripts/, so docs, scratch notes and storage never enter the snapshot.
"""
import hashlib, json, os, subprocess, sys, tarfile
from datetime import datetime, timezone

name = sys.argv[1] if len(sys.argv) > 1 else "implementation"
here = os.path.dirname(os.path.abspath(__file__))
repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
status = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], text=True)
files = []
for line in status.splitlines():
    path = line[3:].split(" -> ")[-1].strip()
    if line[:2].strip() == "D" or not path.startswith(("apps/", "packages/", "scripts/")):
        continue
    if os.path.isfile(os.path.join(repo, path)):
        files.append(path)
files.sort()
digests = {}
for path in files:
    with open(os.path.join(repo, path), "rb") as handle:
        digests[path] = hashlib.sha256(handle.read()).hexdigest()
record = {"createdAt": datetime.now(timezone.utc).isoformat(), "gitHead": head, "files": digests}
with open(os.path.join(here, f"{name}.json"), "w") as handle:
    json.dump(record, handle, indent=1)
    handle.write("\n")
with tarfile.open(os.path.join(here, f"{name}.tar.gz"), "w:gz") as archive:
    for path in files:
        archive.add(os.path.join(repo, path), arcname=path)
print(json.dumps({"snapshot": name, "gitHead": head, "files": len(files)}))
