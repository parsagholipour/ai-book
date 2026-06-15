# Phase 05 Output Notes

## Completed

- Added bearer-only mobile project APIs under `/api/mobile/*`.
- Added mobile-safe DTO serializers for project summary, project detail, plan detail, plan operations, readable status/progress, and export availability.
- Added mobile project creation through product presets instead of raw provider/model/temperature/generation controls.
- Added mobile endpoints for project list/detail/create/status, plan generation, plan revision, plan approval, and PDF/EPUB downloads.
- Preserved existing `/api/projects/*` operator behavior, including advanced generation controls.

## Product Presets

Mobile creation accepts `qualityPreset` values only:

| Preset | Internal intent | Internal mapping |
| --- | --- | --- |
| `fast` | Lower-cost draft path | complexity `4`, temperature `0.65`, final review off, one draft candidate, parallel page generation on |
| `balanced` | Default launch path | complexity `5`, temperature `0.65`, final review on, one draft candidate, parallel page generation on |
| `premium` | Higher-quality export path | complexity `6`, temperature `0.55`, final review on, two draft candidates, parallel page generation off |

Mobile creation also accepts `lengthPreset` values:

| Book type | `short` | `standard` | `expanded` |
| --- | ---: | ---: | ---: |
| `lead_magnet` | 12 pages | 18 pages | 24 pages |
| `workbook` | 16 pages | 28 pages | 40 pages |
| `short_story` | 8 pages | 16 pages | 24 pages |

The mapping stays server-side. Mobile DTOs return the selected preset names but do not expose provider, model, temperature, generation strategy, queue internals, or operator-only controls.

## DTO And Contract Decisions

- Stable DTO names in the API code:
  `MobileProjectCreateRequestDto`, `MobileProjectSummaryDto`, `MobileProjectDetailDto`, `MobilePlanDto`, `MobilePlanRevisionRequestDto`, `MobilePlanOperationDto`, `MobileProjectStatusDto`, and `MobileExportAvailabilityDto`.
- Normal mobile project list/detail responses are shaped as `{ projects: [...] }` and `{ project: ... }`.
- Mobile status is shaped as `{ status: ... }` with user-facing labels, progress percent, current action, failure message, retry availability, simplified steps, page progress, image count, and export availability.
- PDF and EPUB mobile download endpoints return binary files and require the same signed-in mobile owner as the project.
- Route-level OpenAPI request schemas were added for mobile project creation and plan revision. Response contracts are protected with API injection tests and an inline snapshot for the project DTO key set.
- Until Flutter exists, the backend API tests are the contract source of truth for Phase 07 DTO implementation.

## Known Follow-Ups

- Phase 06 must add credits and entitlement gates before expensive plan approval/full generation and export actions.
- Phase 07 can implement Flutter DTOs directly from the Phase 05 API shapes, or generate a Dart client once response schemas are expanded.
- Later phases may add explicit mobile export status endpoints if the app needs separate polling from project detail/status.

## Validation

- `pnpm --filter @book-maker/api typecheck`
- `pnpm --filter @book-maker/api test`
- `pnpm typecheck`
- `pnpm test`
