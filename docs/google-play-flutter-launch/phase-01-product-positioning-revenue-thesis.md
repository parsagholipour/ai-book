# Phase 01 - Product Positioning And Revenue Thesis

## Objective

Define exactly what the Google Play app is selling before mobile or billing engineering begins. The goal is a focused product thesis that can realistically reach USD 1,000/month.

## Current Assumptions

- The backend can already generate planned long-form books, covers, images, PDF, EPUB, and Markdown.
- The current web UI is a technical console, not the final mobile UX.
- The first mobile product should sell a practical outcome, not generic AI writing.
- `Tomeza: AI Book Maker` is the working name, but naming must still be checked for conflicts.

## Decisions To Lock

- First audience: creators, coaches, teachers, and small businesses.
- First primary output: practical ebooks, guides, workbooks, and lead magnets.
- Secondary output: short fiction/story.
- Deferred output: child-directed picture-book app until safety, policy, and image consistency are stronger.
- Revenue goal: USD 1,000/month from a mix of one-book purchases, subscriptions, and credits.

## Implementation Tasks

1. Create or update `docs/google-play-flutter-launch/product-spec.md`.
2. Include the first user persona:
   - Who they are.
   - What job they need done.
   - Why they would pay.
   - What result they expect in the first session.
3. Define the first three book templates:
   - Lead magnet ebook.
   - Workbook or study guide.
   - Short story.
4. Define the minimum user journey:
   - Start from a prompt.
   - Generate an outline/plan.
   - Revise the plan.
   - Generate a preview.
   - Pay or spend credits for full export.
5. Define the first pricing hypothesis:
   - Free outline and limited preview.
   - One-book export purchase.
   - Monthly creator plan.
   - Credit packs for extra usage.
6. Define non-goals:
   - No full marketplace.
   - No author community.
   - No unlimited plan.
   - No complex desktop editor in the first Android release.

## Acceptance Criteria

- A future agent can explain the app in one sentence.
- The USD 1,000/month path is written with rough required customer counts.
- The first templates are chosen and later phases can build around them.
- The product spec rejects generic AI writer positioning.
- The phase output does not require code changes.

## Validation

- Run `git status --short`.
- Confirm only documentation changed unless the user explicitly requested implementation.

## Handoff Notes For Next Phase

Phase 02 should prepare the repo structure and architecture around this product direction. Do not scaffold a broad Flutter app before this product scope is written.
