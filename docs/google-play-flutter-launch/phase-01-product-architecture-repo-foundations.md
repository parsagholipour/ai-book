# Phase 01 - Product, Architecture, And Repo Foundations

## Objective

Prepare the repository and product specification for a Flutter Google Play app without changing the existing backend direction. This phase should leave future agents with a clear monorepo shape, mobile app architecture, product scope, and first revenue target.

## Current Context

The repository already contains:

- `apps/api`: Fastify TypeScript API.
- `apps/worker`: BullMQ generation worker.
- `apps/web`: Vite React local/operator console.
- `packages/core`: generation logic, schemas, prompt templates, exports, adapters, cost utilities.
- `packages/db`: Prisma database schema, migrations, seed logic.

The current web UI is an operator console. The mobile app should become a consumer product with a guided flow.

## Key Decisions

- Add Flutter under `apps/mobile`.
- Keep TypeScript backend apps and packages in their current workspace style.
- Use the backend as the source of truth for generation, project state, exports, billing entitlements, and account data.
- Use the Flutter app only for user experience, local session state, API calls, downloads, sharing, and Google Play Billing client integration.
- First product positioning: practical ebook maker for creators/coaches/teachers/small businesses.
- Keep `Tomeza: AI Book Maker` as the provisional app name until trademark/domain checks are complete.

## Implementation Tasks

1. Create a short product spec in this folder or update this phase with:
   - Target user.
   - First use case.
   - Free, paid, and credit-gated actions.
   - Non-goals for launch.
2. Add a repository architecture note describing:
   - `apps/mobile` Flutter app.
   - Existing TypeScript backend apps.
   - Shared API contract strategy.
   - Environment separation for local, staging, and production.
3. Decide the first mobile navigation model:
   - Home/projects list.
   - New book wizard.
   - Project detail/progress.
   - Preview/export.
   - Account/credits.
4. Decide MVP book types:
   - Nonfiction guide.
   - Workbook/study guide.
   - Short fiction/story.
   - Do not prioritize complex children's picture-book publishing until safety and image consistency are strong.
5. Define launch success metrics:
   - First target: USD 1,000/month revenue.
   - Activation: user creates a plan or preview.
   - Conversion: user buys a book export, credits, or subscription.
   - Cost: generated content must maintain positive gross margin.

## Suggested Files To Add Or Update

- `docs/google-play-flutter-launch/product-spec.md`
- `docs/google-play-flutter-launch/mobile-architecture.md`
- Root `README.md` if the new mobile app setup needs to be visible to developers.
- Optional: root `Makefile` or scripts after later phases create actual commands.

## Acceptance Criteria

- Future agents know that Flutter lives in `apps/mobile`.
- Future agents know not to move generation logic into Flutter.
- MVP scope is narrow enough for a Google Play launch.
- Business target is explicit: first optimize for USD 1,000/month, not a large venture-scale launch.
- Any new documentation uses concrete names and paths from this repo.

## Validation

- Run `git status --short` and confirm only intended documentation files changed in this phase.
- No code generation or app scaffolding is required in this phase unless the user explicitly asks to start implementation.

## Handoff Notes For Next Agent

Start Phase 02 by making the backend safe for real mobile users. The current password-based single-user auth is not enough for Google Play distribution.
