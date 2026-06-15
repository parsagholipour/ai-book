# Mobile UI/UX Improvement Plan

This folder contains a phased agent handoff plan for improving the Flutter mobile app experience after the Google Play launch foundations in `docs/google-play-flutter-launch/`.

The goal is not only a nicer interface. The goal is a product that feels obvious to first-time users, trustworthy during AI generation, fair at the paid moment, and calm when something goes wrong.

Start every agent run with:

1. [Agent Runbook](./AGENT-RUNBOOK.md)
2. This README
3. The current phase file
4. The latest output notes from this folder
5. Relevant launch docs from `../google-play-flutter-launch/`

## Product Context

- Working product name: `Tomeza: AI Book Maker`.
- Primary users: creators, coaches, teachers, consultants, and small business users.
- Core job: turn an idea into a useful ebook, guide, workbook, or short story that can be exported as PDF or EPUB.
- Current mobile surfaces include auth, projects home, new-book wizard, plan review, plan revision, generation progress, generated preview, export, billing/paywalls, account, privacy, and reporting.
- Backend remains authoritative for ownership, credits, entitlements, generation, billing verification, safety, and asset access.

## UX Outcome

A user should always understand:

- What they can do next.
- Why the app is asking for information.
- What the app is creating.
- What is free, what costs credits, and what a credit buys.
- Whether AI work is waiting, running, failed, recoverable, or complete.
- How to revise, retry, report, delete, get help, or leave safely.

## Phase Order

1. [Phase 01 - Baseline UX Audit And Confusion Map](./phase-01-baseline-ux-audit-and-confusion-map.md)
2. [Phase 02 - Information Architecture, App Shell, And Home](./phase-02-information-architecture-app-shell-home.md)
3. [Phase 03 - Design System, Accessibility, And Component Polish](./phase-03-design-system-accessibility-component-polish.md)
4. [Phase 04 - First-Run Onboarding And New-Book Wizard](./phase-04-first-run-onboarding-and-new-book-wizard.md)
5. [Phase 05 - Plan Review, Revision, And Approval Confidence](./phase-05-plan-review-revision-and-approval-confidence.md)
6. [Phase 06 - Generation Progress, Preview, And Recovery](./phase-06-generation-progress-preview-and-recovery.md)
7. [Phase 07 - Export, Billing, Paywall, And Credits Clarity](./phase-07-export-billing-paywall-and-credits-clarity.md)
8. [Phase 08 - Account, Privacy, Support, And Trust](./phase-08-account-privacy-support-and-trust.md)
9. [Phase 09 - Usability Testing, Analytics, And Beta Iteration](./phase-09-usability-testing-analytics-and-beta-iteration.md)

## Agent Prompts

- [Phase 01 Agent Prompt](./phase-01-agent-prompt.md)

## Global UX Rules For Agents

- One screen should have one dominant next action.
- Every major action needs a plain-language consequence before the user commits.
- Hide provider, model, temperature, queue, and internal entitlement language from normal users.
- Prefer concrete outcome language: `Create a guide`, `Review your outline`, `Unlock exports`.
- Avoid abstract action labels like `Submit`, `Process`, `Execute`, or `Run`.
- Progress states must say what is happening now and what will happen next.
- Empty states must help users start, not merely say that nothing exists.
- Error states must offer recovery when recovery exists.
- Paid moments must explain value before price and price before commitment.
- AI disclosure, reporting, account deletion, and support must be easy to find.
- Support large text, screen readers, touch targets, dark mode, poor networks, and low-credit states.

## Full UX Definition Of Done

- A new user can sign up, create a first project, review a plan, revise it, approve generation, understand the wait, preview the result, and understand export options without developer help.
- A returning user can open the app and immediately see which project needs attention.
- A low-credit user understands what is blocked, why, and what purchase or plan unlocks it.
- A failed generation, failed billing attempt, offline state, or missing Play Billing configuration gives a clear path forward.
- Key screens have widget tests for empty, loading, success, error, locked, and accessible text-scale states.
- The app has an analytics and usability-testing loop that measures confusion, activation, conversion, export success, and support burden.

## Key Journeys To Protect

- Fresh install to first generated plan.
- First plan revision to plan approval.
- Plan approval to generation progress.
- Generation complete to export/share.
- Locked export to purchase or restore.
- Failed generation to retry/resume.
- User concern to report/support/delete controls.
