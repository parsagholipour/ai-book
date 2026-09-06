#!/usr/bin/env python3
"""Cost, call and runtime accounting for every job on the development-fixes projects, against the rung-5 baseline.

Sources (all read-only):
  - ProviderCallLog aggregates per (job, provider, model, purpose): providercalls-by-job-purpose.txt (psql export)
  - GenerationJob rows: jobs.txt (psql export)
  - run traces: storage/books/<projectId>/runs/<jobId>-generate-book.jsonl (timestamps, purposes, research searches, evidence events)
  - baseline: docs/composed-chapters/runs/<label>/trace.json (calls per purpose, totals)
Writes cost-accounting.json beside this script.
"""
import glob, json, os, re
from collections import Counter, defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PROJECTS = {
    "cmtnwyp3d0000fwg07qgd68uo": "development-fixes-1 (project 1: 1a, 1a-retry, 1b, 1c, 1d)",
    "cmtnyg6ji0000seg0lrlewwb1": "development-fixes-2a (2a, 2a-retry, 2a-retry-2, 2a-retry-3)",
    "cmtnzo7wf0000qwg0kwq6s3rk": "development-fixes-3a (launched by another session: 3a, 3a-retry, 3a-retry-2, 3a-retry-3)",
}
STAGES = {
    "episodes": {"plan-episodes"},
    "sources": {"case-source-search", "extract-excerpts"},
    "evidence-packets": {"build-case-evidence", "verify-case-evidence"},
    "development-plan": {"develop-book-plan", "review-book-development"},
    "forms": {"plan-chapter-forms", "architect-book"},
    "compose": {"compose-chapter", "compose-scene", "judge-chapter-drafts"},
    "line-edit": {"edit-chapter", "rewrite-couplets", "rewrite-seams", "cut-chapter"},
    "chapter-evidence-review": {"review-chapter-evidence", "verify-chapter-evidence"},
    "developmental-edit": {"plan-developmental-edit", "rewrite-developmental-sections"},
    "describe-pages": {"describe-pages"},
    "manuscript-read": {"read-manuscript"},
}
def stage_of(purpose):
    for stage, purposes in STAGES.items():
        if purpose in purposes: return stage
    return "finalize-compile-other"

def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None

# ---- ProviderCallLog aggregates -------------------------------------------------------------
calls = defaultdict(list)
for line in open(os.path.join(HERE, "providercalls-by-job-purpose.txt")):
    parts = [p.strip() for p in line.rstrip("\n").split(" | ")]
    if len(parts) != 11: continue
    job, provider, model, purpose, count, cost, prompt, output, cache, duration, unpriced = parts
    calls[job].append({"provider": provider, "model": model, "purpose": purpose, "stage": stage_of(purpose), "count": int(count),
                       "costUsd": float(cost) if cost else None, "promptTokens": int(prompt or 0), "outputTokens": int(output or 0),
                       "cacheHitTokens": int(cache or 0), "durationSeconds": round(int(duration or 0) / 1000, 1), "unpricedCalls": int(unpriced)})

# ---- GenerationJob rows ---------------------------------------------------------------------
jobs = {}
for line in open(os.path.join(HERE, "jobs.txt")):
    parts = [p.strip() for p in line.rstrip("\n").split(" | ")]
    if len(parts) < 8: continue
    jid, project, jtype, status, progress, created, started, finished = parts[:8]
    jobs[jid] = {"jobId": jid, "projectId": project, "type": jtype, "status": status, "progress": int(progress),
                 "createdAt": created, "startedAt": started or None, "finishedAt": finished or None}

# ---- labels from manifest and driver logs ---------------------------------------------------
labels = {}
manifest = json.load(open(os.path.join(REPO, "docs/composed-chapters/experiments/2026-09-05-fixes/manifest.json")))
for launch in manifest["launches"]:
    if launch.get("generationJobId"): labels[launch["generationJobId"]] = launch["label"]
for path in glob.glob(os.path.join(REPO, "docs/composed-chapters/experiments/2026-09-05-fixes/development-fixes-*.log")):
    label = os.path.basename(path)[:-4]
    if label.endswith("-export"): continue
    for m in re.finditer(r"GENERATE_BOOK (?:queued|re-queued) \((\w+)\)", open(path).read()):
        labels.setdefault(m.group(1), label)

# ---- traces --------------------------------------------------------------------------------
def trace_summary(project, jid):
    path = os.path.join(REPO, f"storage/books/{project}/runs/{jid}-generate-book.jsonl")
    if not os.path.exists(path): return None
    events = Counter(); starts = []; failed = None; first = last = None; research = 0; unresolved = []
    stage_span = {}
    bad = 0
    for line in open(path):
        try: e = json.loads(line)
        except Exception: bad += 1; continue
        ev = e.get("event"); ts = e.get("timestamp"); events[ev] += 1
        first = first or ts; last = ts
        if ev == "job.start": starts.append(ts)
        if ev == "job.failed": failed = {"at": ts, "message": (e.get("error") or {}).get("message", "")[:400]}
        if ev == "research.search.request": research += 1
        if ev == "generation.composed_chapters.evidence_unresolved":
            unresolved.append({"chapterIndex": e.get("chapterIndex"), "findings": e.get("findings"), "repairs": e.get("repairs"), "unresolved": len(e.get("unresolved") or []), "dropped": e.get("dropped"), "stage": e.get("stage", "compose")})
        if ev in ("text.generateJson.request", "text.generateText.request"):
            purpose = (e.get("request") or {}).get("purpose")
            st = stage_of(purpose)
            span = stage_span.setdefault(st, {"first": ts, "last": ts, "requests": 0})
            span["last"] = ts; span["requests"] += 1
    spans = {st: {"firstRequest": s["first"], "lastRequest": s["last"], "spanMinutes": round((parse_ts(s["last"]) - parse_ts(s["first"])).total_seconds() / 60, 1), "requests": s["requests"]} for st, s in stage_span.items()}
    return {"tracePath": os.path.relpath(path, REPO), "events": dict(events), "unparseableLines": bad, "jobStarts": starts, "firstEvent": first, "lastEvent": last,
            "failed": failed, "researchSearchRequestsUnpriced": research, "evidenceUnresolvedEvents": unresolved, "stageSpans": spans}

# ---- assemble per job ----------------------------------------------------------------------
out_jobs = []
for jid, job in sorted(jobs.items(), key=lambda kv: kv[1]["createdAt"]):
    per = calls.get(jid, [])
    by_stage = defaultdict(lambda: {"calls": 0, "costUsd": 0.0, "promptTokens": 0, "outputTokens": 0, "durationSeconds": 0.0, "unpricedCalls": 0})
    for c in per:
        s = by_stage[c["stage"]]
        s["calls"] += c["count"]; s["costUsd"] += c["costUsd"] or 0; s["promptTokens"] += c["promptTokens"]; s["outputTokens"] += c["outputTokens"]
        s["durationSeconds"] += c["durationSeconds"]; s["unpricedCalls"] += c["unpricedCalls"]
    started = parse_ts(job["startedAt"]); finished = parse_ts(job["finishedAt"])
    elapsed = round((finished - started).total_seconds() / 60, 1) if started and finished else None
    total_cost = sum(c["costUsd"] or 0 for c in per)
    entry = {**job, "label": labels.get(jid), "elapsedMinutes": elapsed,
             "providerCalls": sum(c["count"] for c in per), "providerCostUsd": round(total_cost, 4),
             "promptTokens": sum(c["promptTokens"] for c in per), "outputTokens": sum(c["outputTokens"] for c in per),
             "unpricedProviderCalls": sum(c["unpricedCalls"] for c in per),
             "byStage": {k: {**v, "costUsd": round(v["costUsd"], 4), "durationSeconds": round(v["durationSeconds"], 1)} for k, v in sorted(by_stage.items())},
             "byPurpose": per}
    if job["type"] == "GENERATE_BOOK":
        entry["trace"] = trace_summary(job["projectId"], jid)
    out_jobs.append(entry)

# ---- per project totals --------------------------------------------------------------------
projects = {}
for pid, desc in PROJECTS.items():
    mine = [j for j in out_jobs if j["projectId"] == pid]
    completed = [j for j in mine if j["type"] == "GENERATE_BOOK" and j["status"] == "COMPLETED"]
    failed = [j for j in mine if j["type"] == "GENERATE_BOOK" and j["status"] == "FAILED"]
    active = [j for j in mine if j["status"] in ("ACTIVE", "QUEUED")]
    projects[pid] = {"description": desc,
                     "jobs": len(mine),
                     "totalProviderCostUsd": round(sum(j["providerCostUsd"] for j in mine), 4),
                     "totalProviderCalls": sum(j["providerCalls"] for j in mine),
                     "completedGenerateBookCostUsd": round(sum(j["providerCostUsd"] for j in completed), 4),
                     "failedGenerateBookCostUsd": round(sum(j["providerCostUsd"] for j in failed), 4),
                     "activeSoFarCostUsd": round(sum(j["providerCostUsd"] for j in active), 4),
                     "otherJobsCostUsd": round(sum(j["providerCostUsd"] for j in mine if j["type"] not in ("GENERATE_BOOK",)), 4),
                     "researchSearchRequestsUnpriced": sum((j.get("trace") or {}).get("researchSearchRequestsUnpriced", 0) for j in mine),
                     "activeJobIds": [j["jobId"] for j in active]}

# ---- baseline ------------------------------------------------------------------------------
baseline = {}
for label in ("ladder-5a-apparatus", "ladder-5b-apparatus", "ladder-5c-apparatus", "composed-7"):
    d = json.load(open(os.path.join(REPO, f"docs/composed-chapters/runs/{label}/trace.json")))
    by_stage = defaultdict(lambda: {"calls": 0, "costUsd": 0.0, "promptTokens": 0, "outputTokens": 0})
    for c in d["calls"]:
        s = by_stage[stage_of(c["purpose"])]
        s["calls"] += c["count"]; s["costUsd"] += c.get("cost") or 0; s["promptTokens"] += c.get("promptTokens") or 0; s["outputTokens"] += c.get("outputTokens") or 0
    baseline[label] = {"projectId": d["projectId"], "status": d["status"], "pages": d["pages"], "words": d["words"], "totals": d["totals"],
                       "byStage": {k: {**v, "costUsd": round(v["costUsd"], 4)} for k, v in sorted(by_stage.items())},
                       "byPurpose": d["calls"], "source": f"docs/composed-chapters/runs/{label}/trace.json"}

result = {"capturedAt": datetime.now(timezone.utc).isoformat(), "projects": projects, "jobs": out_jobs, "baseline": baseline,
          "provenance": {"providerCalls": "ProviderCallLog grouped by generationJobId, provider, model, purpose (psql, .scratch/claude-development-fixes/providercalls-by-job-purpose.txt); costHint is the provider-estimated USD per settled call; research searches and document fetches write no ProviderCallLog row and are counted from run traces as unpriced",
                         "jobs": "GenerationJob rows (psql, .scratch/claude-development-fixes/jobs.txt); elapsedMinutes = finishedAt - startedAt",
                         "traces": "storage/books/<projectId>/runs/<jobId>-generate-book.jsonl; stage spans are first-to-last request timestamps of the stage's purposes and overlap across stages",
                         "baseline": "docs/composed-chapters/runs/<label>/trace.json written by scripts/dev-rerun-book.ts export at the time of those runs"}}
json.dump(result, open(os.path.join(HERE, "cost-accounting.json"), "w"), indent=1)
print(json.dumps({pid: {k: v for k, v in p.items() if k != "description"} for pid, p in projects.items()}, indent=1))
for j in out_jobs:
    if j["type"] != "GENERATE_BOOK": continue
    print(j["label"], j["jobId"][-6:], j["status"], "@", j["progress"], "|", j["elapsedMinutes"], "min |", j["providerCalls"], "calls | $", j["providerCostUsd"], "| research", (j.get("trace") or {}).get("researchSearchRequestsUnpriced"), "| unresolved", len((j.get("trace") or {}).get("evidenceUnresolvedEvents") or []))
