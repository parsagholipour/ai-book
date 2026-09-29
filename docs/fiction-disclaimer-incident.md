# Fiction disclaimers in story prose — 29 September 2026

The latest completed book, *The Last Table at Café Maré*
(`cmultc631001fytls5a6doywi`), opened with “In this invented scene”.
Page 3 also called its neighborhood benefit fictional.

The saved generation trace shows that the initial opening contained no
disclaimer. After an editorial revision, `verify-page-claims` received research
notes and the café scene without the book's request, category or premise. It
treated the imagined encounter and dialogue as unsupported reporting and asked
for a fictionalization label. The next rewrite inserted the disclaimer.

An editor subsequently identified the disclaimer, but the feedback filter
discarded its specific complaint and repair as a fabrication-only concern.
The word “invented” in a critique of the framing was mistaken for a claim that
the underlying source was invented.

Both initial and changed-page grounding now receive the request, category and
premise. Their instructions distinguish fictional action from factual background
claims. This matters for CUSTOM books as well as STORY: this book was CUSTOM.
Planning, drafting, revision and editorial prompts keep fictional-status notes
out of narration. Confirmed prompt-leak findings retain their diagnosis and
repair through feedback normalization. No automatic prose deletion was added.

Regression tests cover the worker-to-verifier context, both grounding passes,
draft/revision prompts and preservation of the editor's exact feedback. A live
replay with `gpt-6-luna` accepted the original imagined encounter, rejected the
published disclaimer and still rejected a deliberately incorrect career date.

The saved book was repaired through the existing manual-edit operation, retaining
undo snapshots. Only the framing on pages 1 and 3 changed. Page 7's “invented
caption” describes a false gossip post within the plot and was preserved. The
compile completed; PDF, EPUB and DOCX digests matched content revision 1. Local
replay evidence and before/after snapshots are under
`.scratch/fiction-opening-2026-09-29/`.

## Recurrence: After the Cameras

The next book, *After the Cameras* (`cmuluuwej001qytlskdhaq5xk`), included
“the football star in this fictional encounter” on page 1 and called the
in-story headline fictional on pages 7 and 8. Its actual provider requests
contained none of the new fiction instructions. Checking the edited source
and replaying individual calls had not established what the running worker used.

The development launcher left an old worker reparented to PID 1 while nodemon
started another. The tsx CLI spawned the application in a separate process;
nodemon observed the wrapper exit before the application had finished draining.
The old application continued consuming jobs with the old prompts. The API had
the same orphaning problem and its replacement could not bind the occupied port.

`tsx-dev.mjs` now launches a Node entry loader directly under nodemon. The loader
registers tsx in the supervised process and imports the TypeScript entry point.
The restart test runs the actual launcher with an application that delays its
shutdown: the first application must record that it stopped before the second
starts. It also verifies final shutdown. The old launcher failed this lifecycle
sequence; the fix passed on the host and in the Docker Node runtime.

There was a second gap: the page editor explicitly rejected the “fictional
encounter” as an intrusive disclaimer but set `promptLeakFree=true` and
`styleNatural=false`. The earlier repair preserved only prompt-leak rejections,
so feedback normalization still erased this style rejection and approved it.
The captured request, draft and verdict now form a regression fixture. Explicit
editorial findings about narration framing survive both fabrication filtering
and the permissive approval path. This classification examines the editor's
feedback; it does not delete matching words from the story.

The services were restarted and verified to have one supervised application
each. A real worker restart also left one worker, with the replacement waiting
for the previous process. A fresh run using the exact saved input and plan was
queued as `cmulvree200002wlsx25ws43w`; its saved requests confirm the new rules
reach drafting, polishing, review and revision.

The user's original book was repaired through the manual-edit operation
`cmulvs880000045lszcf6hq7d`, preserving undo. Only the three framing passages
changed. Compile `cmulvs8b2000545lsmzp2d6p2` completed, and all three published
export digests match content revision 1. Evidence is retained under
`.scratch/fiction-encounter-2026-09-29/`.

The fresh run completed on 29 September at 03:38 Dubai time. All ten final
pages were read and contained no fictional-status narration. The final prose
matched the inspected manuscript, and text extracted from PDF, EPUB and DOCX
contained none of the offending phrases. The same export-text check passed for
the repaired original book, including the replacement identification sentence.
The run still reported unrelated brief-coverage warnings, so this is evidence
for the narration repair and successful publication, not a claim that every
editorial dimension passed. The temporary test book was removed after its
manuscript, run logs and exports were captured locally; the original remains.

`pnpm check` passed typecheck, lint, size, gotcha, subpath and script-test gates.
All 4,652 core tests passed, including the captured rejection. The workspace
test gate still failed on the existing `exportTempCleanup.test.ts` timeouts;
that file passed all 11 tests in isolation. Full results are in
`check-final.log` and `export-cleanup-isolated.log` under the incident evidence
directory.
