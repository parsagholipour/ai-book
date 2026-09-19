# Changed candidate grounding

`changedCandidateGrounding` is an independent per-page quality gate, enabled by
default for every tier and disableable in the generation quality settings. The
existing `claimVerifier` gate still controls initial enrichment. Disabling either
one does not disable the other. Jev routing is configured separately; without a
decision route, changed candidates go directly to `verify-page-claims`.

This implements the final-candidate grounding recommendation in
[the Jev audit](quality-gates-jev-audit-2026-09-18.md).

## Review and publication

1. `enrichPageQualityReport` verifies the initial draft as before.
2. `runPageQualityLoop` retains that seed's grounding result for its exact title,
   prose and research notes. Each changed candidate receives the dedicated check
   before approval or score-based selection, including candidates rejected by the
   general reviewer. The check does not replace general review or style audits.
3. Jev sees the full original and changed title/prose, supplied research notes,
   and authorized private source passages. It judges new unsupported assertions,
   statistics, attribution, quotations, contradictions and changes to certainty,
   uncertainty or scope. A clean result requires support for the remaining claims;
   removing an unsupported assertion is a valid repair.
4. Suspected defects, insufficient context, low/invalid confidence and decision
   failures go directly to the existing claim verifier for concrete findings and
   repair instructions. There is no intervening generic text-model choice.
5. Findings enter the existing page rewrite budget. Every changed repair is
   checked again. Identical title/prose and evidence reuse their result, including
   failed or unavailable results. The cache lives only for this page loop, with
   the original and authorized source versions fixed; different supplied research
   notes require a new judgment. Retrieved research accompanies the rewrite,
   subsequent reviewer and grounding check.
6. Selection retains the candidate's own report, including when an earlier
   candidate wins. Existing staging/publication consumes that draft/report pair.
   An unresolved failure remains `FAILED_QA`; the existing best-draft publication
   and final repair policies still apply. No new publication exception is added.

Chat rewrites and final export repairs already change the seed before entering
the loop, so they supply the pre-rewrite original. A chat rewrite that inherits
general approval by retaining most prose still owes the grounding check when it
changes factual text. Exact manual replacements retain their existing path.

## Evidence and outcomes

Private sources are prepared through `SourceAwareTextModel`, which uses the
existing ownership/version authorization and reads cited passages even when
search ranks other evidence. Jev and diagnostic retries reuse this frozen pack;
source overviews alone do not count as returned passages. Existing figure
handling is preserved: grounding reads figure-free prose.

`verified` means a supported screen or successful diagnostic. `failed` carries
unsupported claims and repair instructions. `unavailable` records preparation or
verifier failure; `unverified_no_sources` records absent evidence; `not_applicable`
applies outside factual intent. Unavailable/missing evidence does not clear another
gate's failure or become a verified pass. Cancellation propagates. Provider calls
use the existing logged adapters; the logical outcome records
`changed-page-grounding-v1` and `verificationAvoided` separately from billed calls.

The colocated core and worker fixtures cover introduced statistics, changed
attribution, overstated certainty and uncertainty, contradictory evidence,
claim removal, absent evidence, authorized cited passages, unavailable providers,
cancellation, deduplication, changed evidence, bounded repair, earlier-candidate
selection, chat approval inheritance, and export publication. These are mocked
provider contract/regression tests, not a live accuracy calibration of Jev.
