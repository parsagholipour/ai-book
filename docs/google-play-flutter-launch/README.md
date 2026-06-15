# Google Play Flutter Launch Plan

This folder contains a phased agent handoff plan for turning the current AI Book Maker service into a Google Play app built with Flutter while keeping the backend in this same TypeScript monorepo.

This second iteration intentionally breaks the work into more phases. Each phase has a narrower goal, clearer acceptance gate, and fewer hidden decisions for the next AI agent.

Start every agent run with:

1. [Agent Runbook](./AGENT-RUNBOOK.md)
2. This README
3. The current phase file
4. Any output notes created by earlier phases

## Product Direction

- Working product name: `Tomeza: AI Book Maker`.
- Primary first market: creators, coaches, teachers, and small business users who want practical ebooks, guides, workbooks, or lead magnets.
- Secondary market after validation: personalized fiction and children's books.
- First revenue goal: stable USD 1,000/month, not venture-scale growth.
- Core promise: create, refine, illustrate, export, and share useful books from a guided mobile workflow.

## Repository Direction

- Keep everything in this repository.
- Preserve the current TypeScript backend workspace style.
- Add the Flutter app as `apps/mobile`.
- Keep generation, cost tracking, exports, user ownership, billing checks, and safety enforcement on the backend.
- Use Flutter for mobile UX, local session state, API calls, downloads, sharing, and Google Play Billing client flows.

## Phase Order

1. [Phase 01 - Product Positioning And Revenue Thesis](./phase-01-product-positioning-revenue-thesis.md)
2. [Phase 02 - Monorepo And Flutter Architecture Foundation](./phase-02-monorepo-flutter-architecture-foundation.md)
3. [Phase 03 - Backend Multi-User Accounts And Auth](./phase-03-backend-multi-user-accounts-auth.md)
4. [Phase 04 - Project Ownership, Assets, And Data Boundaries](./phase-04-project-ownership-assets-data-boundaries.md)
5. [Phase 05 - Mobile API Contract And Product Presets](./phase-05-mobile-api-contract-product-presets.md)
6. [Phase 06 - Credits, Cost Model, And Entitlement Design](./phase-06-credits-cost-model-entitlement-design.md)
7. [Phase 07 - Flutter App Shell, Design System, And Auth](./phase-07-flutter-app-shell-design-system-auth.md)
8. [Phase 08 - Mobile Book Creation And Planning Workflow](./phase-08-mobile-book-creation-planning-workflow.md)
9. [Phase 09 - Generation Progress, Preview, Editing, And Export](./phase-09-generation-progress-preview-editing-export.md)
10. [Phase 10 - Google Play Billing And Paywalls](./phase-10-google-play-billing-paywalls.md)
11. [Phase 11 - Safety, Privacy, Compliance, And Store Readiness](./phase-11-safety-privacy-compliance-store-readiness.md)
12. [Phase 12 - Production Deploy, Beta, Launch, And Growth Loop](./phase-12-production-beta-launch-growth-loop.md)

## Global Rules For Agents

- Do not create a separate repository.
- Do not replace the current backend stack.
- Do not rewrite generation logic in Dart.
- Do not expose provider, model, temperature, or raw queue details to normal mobile users.
- Do not offer unlimited generation, unlimited images, or unlimited voice.
- Treat AI cost, safety, moderation, ownership, and Google Play policy as product requirements.
- Keep each phase independently testable.
- Update this folder when a phase changes a decision that later phases depend on.

## Full Goal Definition Of Done

- `apps/mobile` builds a Flutter Android app.
- A real signed-in user can create a book, review a plan, approve generation, monitor progress, preview output, and export/share PDF or EPUB.
- The backend supports real users, project ownership, mobile-safe auth, credits, entitlements, billing verification, cost tracking, and app-facing APIs.
- Google Play Billing supports subscriptions or credit packs without allowing unbounded AI usage.
- The app includes report/flag flows, privacy policy, account deletion, data safety documentation, and production reliability checks.
- Internal testing, closed testing, release signing, production deployment, and launch analytics are documented and repeatable.
