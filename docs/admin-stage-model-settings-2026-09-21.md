# Generation stage model settings

The Quality tab now exposes a primary model, fallback model, and supported reasoning setting for each named text-generation stage in Quick, Balanced, Premium, and Ultra. Planning, chapter forms, composition, editing, manuscript review, page mapping, page review, evidence work, and supporting steps have independent selections.

The **Set all stages** shortcut above the list applies a model and reasoning setting to primary models, fallback models, or both in the selected tier. Optional recommended-effort rules let the operator assign different model and reasoning choices to non-overlapping score ranges (1–10). Only stages in a rule's range change; stages outside every range keep their draft settings. The shortcut updates the draft; individual stages remain editable before publishing with **Save setting**. Other tiers and default routes stay unchanged. Rules are temporary console inputs, not saved policy.

Every stage displays a **recommended effort from 1–10**, with a short explanation. These are editorial starting points based on the stage's reasoning demands, shared across tiers: 1 means lightest reasoning and 10 means deepest. They are not benchmark results or provider parameters. Choose among the selected model's supported effort options. Recommendations live only in the console (`generationStageEffort.ts`); applying a bulk rule changes matching draft stages, while the scores and rules themselves are never saved or used by runtime routing. Finite Jev decisions continue to have no effort control.

The stage registry is `GENERATION_MODEL_STAGES` in `packages/core/src/adapters/generationTextModelRouting.ts`. Its IDs are provider-call purposes, so the admin row and runtime dispatch share an identifier. Keep this module free of runtime imports: the console consumes its browser-safe subpath.

## Authority and compatibility

- The live router reads the latest revision at a logical call boundary. It passes the selected model and reasoning parameters through unchanged. A bound retry keeps its primary/fallback pair; the next call can see a newer revision.
- The old Premium/high and Ultra/max effort elevation, including numeric Gemini budget boosts, has been removed. `planThinkingBoost` is a retired compatibility key and cannot be reactivated by an older saved revision.
- Legacy revisions seed stages from the saved Writer, Judgment, or Fast judgments choice. Finite draft-comparison stages preserve an existing Jev choice and its selected fallback. No higher effort is introduced during migration.
- A model-settings save snapshots all current stages before applying changes to default routes. Later edits to Writer, Judgment, or global decision defaults leave saved stages unchanged. Those defaults remain visible for new stages and unlisted operations.
- PATCH updates only the stage fields named by the operator. Unknown stage/field names and unsupported model/effort combinations are rejected before writing. Concurrent-save rebasing preserves untouched stage choices.
- Model reset explicitly resets known stages, retaining unknown future settings. Gate reset leaves model settings alone. Retired gates remain attributable in historical cost reports.
- Draft-comparison stages can explicitly select Jev or a text model. A global Jev setting cannot replace a saved stage text-model choice. The book's Fast judgments wrapper also respects the chapter-comparison stage.
- Output-token allowances remain distinct from reasoning effort. The chapter allowance safeguard accommodates an explicitly selected high/max effort; it does not elevate the effort.

## Verification

The regression first failed with selected `medium` and actual `max` on Ultra composition. It passes after removal of the elevation policy. Coverage includes all registered stages and tiers, selected efforts, numeric/off settings, stage fallback, pinned calls, legacy migration, finite decisions, API save/reload/reset/validation, and concurrent browser draft rebasing.

The browser flow changes Ultra planning to high and editing to low, verifies drafting remains medium, saves only those two stage leaves, switches tiers, reloads, and checks desktop/mobile overflow and JavaScript errors.

`pnpm check` passed all seven gates (140.8 seconds). The follow-up API route suite passed all 22 tests, including preservation of unclaimed fields from a newer console. Browser screenshots were inspected at desktop and mobile widths.

The previous 20-page audit measured the old routing policy; its timings and costs are historical results, not a benchmark of these new settings. No new paid book run was needed to verify configuration authority.
