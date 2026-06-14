# Phase 07 - Beta, Store Launch, And Growth Loop

## Objective

Prepare and launch the Flutter Android app on Google Play, then iterate toward the first USD 1,000/month revenue milestone.

## Launch Strategy

Launch narrowly. The first version should sell a clear practical outcome:

- Create useful ebooks, guides, and workbooks from a guided mobile workflow.
- Export clean PDF/EPUB files.
- Pay only when users need full generation/export or more credits.

Do not market as a generic AI writer.

## Implementation Tasks

1. Release setup:
   - Configure Android package name.
   - Configure app icon and adaptive icon.
   - Configure signing.
   - Configure release builds.
   - Verify app versioning.
2. Store listing:
   - Final app name under Play title limits.
   - Short description focused on outcome.
   - Long description with honest AI disclosure.
   - Screenshots from real mobile flows.
   - Feature graphic.
   - Privacy policy and support links.
3. Testing tracks:
   - Internal testing.
   - Closed testing with real devices.
   - Production release checklist.
   - Crash and analytics review.
4. Analytics:
   - Track activation: project created, plan generated, preview generated.
   - Track monetization: paywall viewed, purchase started, purchase completed, export unlocked.
   - Track cost: credits spent, provider cost per project, failed generation.
   - Track retention: user returns after first project.
5. Growth loop:
   - Add shareable exported PDF/EPUB flow.
   - Add referral or coupon only after paid conversion works.
   - Add example templates for high-ROI niches: lead magnet, workbook, course guide, client onboarding guide.
   - Add landing page after app flow is stable.

## Acceptance Criteria

- Android release build is reproducible.
- Internal testing install works on at least two physical Android devices.
- Closed test users can sign up, create a book, pay or use credits, and export.
- Store listing assets are complete.
- Privacy/Data Safety/AI policy requirements are answered consistently with the app.
- Analytics can show whether the app is moving toward USD 1,000/month.

## Tests And Validation

- Run Flutter release build.
- Test fresh install, update, logout/login, purchase restore, and failed payment.
- Test poor network behavior during generation progress.
- Test project export on Android share sheet.
- Test backend production health checks.
- Confirm production worker processes jobs after deploy.

## Post-Launch Iteration

Use the first 100-300 users to decide what to build next:

- If users create plans but do not pay, improve preview quality and paywall timing.
- If users pay once but do not return, add templates, editing tools, and saved brand/style profiles.
- If costs are high, adjust presets and credit pricing before adding more features.
- If reviews mention quality, prioritize editing/regeneration controls over new categories.
- If one niche converts better, narrow the store listing and onboarding around that niche.
