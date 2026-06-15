# Phase 05 - Mobile API Contract And Product Presets

## Objective

Create stable mobile-facing APIs and DTOs that hide internal generation complexity behind simple product presets.

## Product Principle

The mobile app should ask users what they want to make. It should not ask them to choose provider, model, temperature, generation strategy, or raw queue behavior.

## Implementation Tasks

1. Define mobile project creation DTO:
   - Book type.
   - Title.
   - Author name.
   - Prompt.
   - Length preset.
   - Quality preset.
   - Images on/off if allowed.
   - Language if needed.
2. Map product presets to backend settings:
   - `fast`
   - `balanced`
   - `premium`
   - Keep mappings server-side.
3. Add mobile endpoints:
   - `GET /api/mobile/me`
   - `GET /api/mobile/projects`
   - `POST /api/mobile/projects`
   - `GET /api/mobile/projects/:id`
   - `GET /api/mobile/projects/:id/status`
   - `POST /api/mobile/projects/:id/plan`
   - `POST /api/mobile/plans/:id/revise`
   - `POST /api/mobile/plans/:id/approve`
   - `GET /api/mobile/projects/:id/export/pdf`
   - `GET /api/mobile/projects/:id/export/epub`
4. Define mobile status DTO:
   - User-readable step labels.
   - Progress percent.
   - Current action.
   - Failure message and retry availability.
5. Define API contract flow:
   - Generate or document OpenAPI.
   - Keep DTO names stable.
   - Add tests that fail when response shape changes unexpectedly.

## Acceptance Criteria

- Flutter can use mobile APIs without internal backend knowledge.
- Normal mobile DTOs do not include raw provider/model/temperature controls.
- Product presets are documented.
- Mobile status is readable and not queue-centric.
- Existing web/operator console can still access advanced controls if needed.

## Tests

- API tests for mobile project creation.
- API tests for preset mapping.
- API tests for status DTO shape.
- API tests for plan revise and approve.
- Contract snapshot tests if practical.
- Run `pnpm typecheck`.
- Run `pnpm test`.

## Handoff Notes For Next Phase

Phase 06 should add the credit and entitlement model before Flutter builds paid flows. Expensive backend actions must have server-side gates.
