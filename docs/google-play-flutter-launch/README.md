# Google Play Flutter Launch Plan

This folder contains phased handoff documents for turning the current AI Book Maker service into a Google Play app built with Flutter while keeping the backend in this same TypeScript monorepo.

Use the files in order. Each phase is intended to be given to an AI agent as the primary implementation brief for that phase. Agents should read this index, the current phase document, and any phase outputs produced earlier before changing code.

## Product Direction

- Working product name: `Tomeza: AI Book Maker`.
- Primary first market: creators, coaches, teachers, and small business users who want a practical ebook, guide, workbook, or lead magnet.
- Secondary market after validation: personalized fiction and children's books.
- First revenue goal: reach a stable USD 1,000/month before optimizing for scale.
- Core promise: create, edit, illustrate, export, and share useful books from a guided mobile workflow.

## Repository Direction

- Keep everything in this repository.
- Preserve the current TypeScript workspace style for backend packages and apps.
- Add Flutter as a sibling app under `apps/mobile`.
- Continue using the existing API, worker, Prisma database, Redis queue, and shared core package as the backend foundation.
- Avoid rewriting the backend in Dart or moving generation logic into the mobile app.

## Phase Order

1. [Phase 01 - Product, Architecture, And Repo Foundations](./phase-01-product-architecture-repo-foundations.md)
2. [Phase 02 - Backend Productization For Mobile](./phase-02-backend-productization-for-mobile.md)
3. [Phase 03 - Flutter MVP App Shell And Auth](./phase-03-flutter-mvp-app-shell-and-auth.md)
4. [Phase 04 - Mobile Book Creation, Progress, And Export](./phase-04-mobile-book-creation-progress-export.md)
5. [Phase 05 - Monetization, Credits, And Entitlements](./phase-05-monetization-credits-entitlements.md)
6. [Phase 06 - Compliance, Safety, Privacy, And Reliability](./phase-06-compliance-safety-privacy-reliability.md)
7. [Phase 07 - Beta, Store Launch, And Growth Loop](./phase-07-beta-store-launch-growth-loop.md)

## Global Rules For Agents

- Do not create a separate repository.
- Do not replace the current backend stack.
- Do not expose model/provider controls to normal mobile users unless explicitly required by an admin/debug surface.
- Do not offer unlimited generation, unlimited images, or unlimited voice features.
- Treat AI cost, safety, moderation, and Google Play policy compliance as product requirements.
- Keep implementation changes small enough to verify with tests before moving to the next phase.
- Update this folder when a phase changes an assumption that affects later phases.

## Definition Of Done For The Full Goal

- A Flutter Android app can be built from `apps/mobile`.
- The app lets a signed-in user create a book project, answer planning prompts, generate content, monitor progress, preview output, and export/share a PDF or EPUB.
- The backend supports multiple users, mobile-safe authentication, credit/entitlement checks, project ownership, cost tracking, and app-facing APIs.
- Paid plans or credit packs are available through Google Play Billing.
- The app includes required safety/reporting, privacy, account deletion, and data handling flows.
- Internal testing, closed testing, store assets, release signing, and production deployment are documented and repeatable.
