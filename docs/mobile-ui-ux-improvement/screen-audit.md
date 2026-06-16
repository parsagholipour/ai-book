# Phase 01 Screen Audit And Confusion Map

This audit covers the current Flutter mobile app in `apps/mobile` after the Google Play launch phases 07-11. It documents the present UX behavior only. It does not redesign the app and does not add analytics SDKs.

## Source Files Inspected

- `apps/mobile/lib/app/routing/app_router.dart`
- `apps/mobile/lib/app/theme/app_theme.dart`
- `apps/mobile/lib/shared/ui/feedback/app_feedback.dart`
- `apps/mobile/lib/features/auth/presentation/auth_screen.dart`
- `apps/mobile/lib/features/projects/presentation/projects_home_screen.dart`
- `apps/mobile/lib/features/projects/presentation/new_book_wizard_screen.dart`
- `apps/mobile/lib/features/projects/presentation/project_detail_screen.dart`
- `apps/mobile/lib/features/projects/presentation/generation_progress_screen.dart`
- `apps/mobile/lib/features/billing/presentation/billing_paywall.dart`
- `apps/mobile/lib/features/account/presentation/account_screen.dart`
- `apps/mobile/test`

## Route And Screen Inventory

| Route | Screen | Owner or feature area |
| --- | --- | --- |
| `/auth/sign-in` | `AuthScreen(mode: signIn)` | Auth |
| `/auth/sign-up` | `AuthScreen(mode: signUp)` | Auth |
| `/home` | `ProjectsHomeScreen` | Projects home with billing summary |
| `/books/new` | `NewBookWizardScreen` | Project creation |
| `/projects/:id` | `ProjectDetailScreen` | Project plan and approval |
| `/projects/:id/handoff` | `GenerationProgressScreen` | Generation progress, preview, export, reporting |
| `/account` | `AccountScreen` | Account, privacy, support, deletion |

The router redirects signed-out users to `/auth/sign-in`, redirects signed-in users away from auth routes to `/home`, and uses `/splash` while session restoration is loading. Unknown routes show `Screen not found` with a home retry action.

## Route Notes

### `/auth/sign-in`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Auth |
| User purpose | Return to an existing Tomeza account. |
| Primary action | `Sign in` with email and password. |
| Secondary actions | Toggle password visibility, go to `Create account`. |
| Empty state | None. The screen is a form. |
| Loading state | Submit button disables and shows a spinner. Route-level session restore uses `/splash`. |
| Error state | Field validation for invalid email or empty password. API errors appear as SnackBars through `userFacingError`. |
| Paid or credit-related state | None. |
| Accessibility and text-scale risks | The form is centered and scrollable, which helps large text. The brand/title stack may push the primary action below the fold at high text scale. SnackBar-only API errors may be missed by screen reader users or users who look away. |
| Likely confusion points | The screen gives minimal value context before sign-in. There is no visible support, privacy, or password recovery path. `Create account` appears both as an auth mode switch and a destination, but it is understandable. |
| Recommended follow-up phase | Phase 04 for first-run context, Phase 08 for trust/support links, Phase 03 for error accessibility. |

### `/auth/sign-up`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Auth |
| User purpose | Create a new account before using the app. |
| Primary action | `Create account` with email and password. |
| Secondary actions | Optional name, toggle password visibility, return to sign-in. |
| Empty state | None. The screen is a form. |
| Loading state | Submit button disables and shows a spinner. |
| Error state | Field validation for invalid email and password under 8 characters. API errors appear as SnackBars. |
| Paid or credit-related state | None. |
| Accessibility and text-scale risks | Same centered scrollable layout as sign-in. Password rule appears only after validation, so users using assistive tech may discover the requirement late. |
| Likely confusion points | No visible terms, privacy, support, or AI disclosure before account creation. The user does not yet know what is free, what requires credits, or what happens after account creation. |
| Recommended follow-up phase | Phase 04 for onboarding, Phase 08 for trust links and policy access, Phase 07 for plain credit expectations after account creation. |

### `/home`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Projects home with billing summary. |
| User purpose | See saved projects, credit balance, and start or resume work. |
| Primary action | `New` in the `Start a new book` panel. |
| Secondary actions | Open account, log out, pull to refresh, get credits, open a project card. |
| Empty state | `No books yet` with `Your saved book projects will appear here.` The separate new-book panel above it provides the actual start action. |
| Loading state | Credits and projects load independently with `Loading credits` and `Loading projects`. |
| Error state | Credits and projects can fail independently with generic `Credits unavailable` or `Projects unavailable` retry states. |
| Paid or credit-related state | `Credits` panel shows available credits, reserved credits, lifetime spent credits, export unlock count, and `Get credits`. |
| Accessibility and text-scale risks | The start panel uses a horizontal row with text plus `New`; at large text sizes the button can become cramped. Metric chips such as `Reserved`, `Spent`, and `Export unlocks` may wrap heavily. Project cards are tappable but do not expose a visible `Open` action. |
| Likely confusion points | The empty project message is passive and does not tell the user to tap `New`. `Reserved`, `Spent`, and `Export unlocks` are internal-ish concepts for a new user. Home does not prioritize the project that needs attention. `Get credits` can compete with `New` before the user understands why credits matter. |
| Recommended follow-up phase | Phase 02 for information architecture, home hierarchy, and next-action surfacing. Phase 07 for credit language. Phase 03 for dense-row accessibility. |

### `/books/new`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Project creation. |
| User purpose | Create a saved book project from buyer-facing presets and a prompt. |
| Primary action | Step-by-step `Continue`, then `Create project`. |
| Secondary actions | `Back`, select book type, length, finish, and visuals toggle. |
| Empty state | None. The route is a wizard. |
| Loading state | `Create project` disables and shows a spinner during submission. |
| Error state | Prompt/title validation is inline. API errors appear as SnackBars. |
| Paid or credit-related state | None on-screen. The wizard does not show whether selected length, finish, or visuals affect future credits. |
| Accessibility and text-scale risks | The bottom navigation bar is fixed, so high text scale plus keyboard can reduce visible context. Choice cards use rows with icon, text, and radio icon; long option labels or localization could squeeze. The switch tile is accessible by default but credit consequence is not explicit. |
| Likely confusion points | `Choose the finish`, `Balanced`, and `Extra polish` may be clear enough for creators but do not explain cost or time impact. `Include cover and selected visuals` says value but not whether it affects credits. The user cannot preview the full request before creating the project. |
| Recommended follow-up phase | Phase 04 for onboarding and wizard clarity, Phase 07 for credit expectations, Phase 03 for text-scale checks. |

### `/projects/:id`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Project plan and approval. |
| User purpose | Generate a plan, answer plan questions, request revisions, approve the plan, or return to generation progress. |
| Primary action | Varies by state: `Create book plan`, `Revise with answers`, `Send revision`, `Approve and start writing`, or `View generation progress`. |
| Secondary actions | Refresh, delete project, previous/next question, skip question, select suggested answers, enter custom answer. |
| Empty state | A no-plan card shows `Ready for a plan` or `Creating your book plan` with `Create book plan` or disabled `Plan requested`. |
| Loading state | Route-level `Loading book plan`; action-level spinners for plan generation, revision, approval, and deletion. Plan polling refreshes every 4 seconds while planning. |
| Error state | Route-level `Plan unavailable` with retry. Plan, revision, approval, and deletion failures appear as SnackBars. |
| Paid or credit-related state | Approval card shows estimated package credits and available credits when billing has loaded. Insufficient credits opens the paywall. Approval dialog confirms estimated credit use. Existing export unlocks are checked, but wording still says writing credits may be spent. |
| Accessibility and text-scale risks | This is a long, dense screen with several cards and multiple actions. Plan questions use `FilterChip` options that can wrap. SnackBar-only errors are easy to miss. The primary action changes by scroll position, and no sticky next action exists. |
| Likely confusion points | Plan answers, revision request, approval, and delete project can all coexist, so the intended next step is not always obvious. `Skip` stores `No preference`, but the user may not know skipped answers will be sent as plan input. `Version` is likely unnecessary for normal users. Credit estimates are numeric but do not explain what a credit buys or whether approval immediately spends credits. Delete is visible in the creation flow and can distract from the main task. |
| Recommended follow-up phase | Phase 05 for plan review and approval confidence, Phase 07 for credit explanation, Phase 08 for delete/trust placement, Phase 03 for dynamic text and SnackBar alternatives. |

### `/projects/:id/handoff`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Generation progress, preview, export, reporting. |
| User purpose | Monitor full-book generation, recover from failures, preview generated content, report content, download, unlock, or share exports. |
| Primary action | Varies by state: wait/refresh, `Retry generation`, `Unlock PDF` or `Unlock EPUB`, `Get credits`, `Download PDF` or `Download EPUB`, `Share`. |
| Secondary actions | Refresh, report book, report visual, pull to refresh. |
| Empty state | Preview card says generated pages will appear when writing starts. Export tiles say files are preparing until generation finishes. |
| Loading state | Route-level `Checking book progress`. Project detail and billing may still be absent while status is visible, causing preview and credit-specific export context to be incomplete. |
| Error state | Route-level `Progress unavailable` with retry. Resume, report, download, and share failures appear as SnackBars. Image loading failures show an unavailable image icon. |
| Paid or credit-related state | Export tiles show locked, insufficient-credit, unlocked, and ready states. Locked exports can open the paywall. Download/share relies on backend enforcement. |
| Accessibility and text-scale risks | Progress percentage and step icons need clearer semantics in later phases. Image-unavailable icon has no explanatory text. Export action wraps can become dense at high text scale. Report actions are available but low in the preview card. |
| Likely confusion points | The screen can show progress, preview, and export cards together even when only some data is ready. `initialMessage` may show an older action below the current action. No visible `last updated` time means stale polling is hard to diagnose. `Downloads stay protected by your account and project unlock` is not plain enough. `Unlock PDF` may imply a separate unlock action, but tapping may spend credits through the download endpoint. |
| Recommended follow-up phase | Phase 06 for progress, preview, staleness, and recovery; Phase 07 for export and credit clarity; Phase 08 for report visibility; Phase 03 for progress/image semantics. |

### `/account`

| Field | Current state |
| --- | --- |
| Screen owner or feature area | Account, privacy, support, deletion. |
| User purpose | Find support, privacy, terms, account deletion information, AI disclosure, retention notes, and request account deletion. |
| Primary action | `Request account deletion` is the only action button. |
| Secondary actions | Select/copy support email and policy URLs. |
| Empty state | None. Static settings content. |
| Loading state | Account deletion request button disables and shows a spinner. |
| Error state | Account deletion request failures appear as SnackBars. |
| Paid or credit-related state | Retention copy mentions billing records. Billing management itself is not available here. |
| Accessibility and text-scale risks | Long URLs in `SelectableText` can create dense wrapping. Rows look informational, not actionable. Dialog confirmation for deletion request has optional note but no post-submit details beyond a SnackBar. |
| Likely confusion points | Support email, privacy policy, terms, and deletion page are visible but not clickable actions. Placeholder defaults can surface if production config is not set. Users may not understand the difference between deleting a project and requesting account deletion. There is no direct billing or subscription management path here. |
| Recommended follow-up phase | Phase 08 for trust, support, privacy, deletion, and production policy link treatment; Phase 07 for subscription/billing management clarity; Phase 03 for long-text layout. |

## Confusion Map

### Unclear Labels

- `New` on home is compact but less clear than `Start book` or `New book` for first-time users.
- `Reserved`, `Spent`, and `Export unlocks` in the credits panel require product knowledge.
- `Choose the finish`, `Balanced`, and `Extra polish` do not explain time, quality, or credit consequences.
- `Version` in plan review exposes plan mechanics that do not help most users.
- `Plan requested` is disabled-state copy, but it does not say whether the app is working, waiting, or how to refresh.
- `Unlock PDF` and `Unlock EPUB` may not make clear that credits can be spent by continuing.
- `Downloads stay protected by your account and project unlock` uses abstract product terms.

### Too Many Competing Actions

- Home shows account, logout, get credits, new book, refresh, and project cards before the user has a clear next step.
- Project detail can show delete project, answer questions, skip, previous/next, revise with answers, free-form revision, approval, and refresh.
- Generation handoff can show progress, retry, preview, report, export unlock, download, share, and refresh in one long scroll.
- Paywall product tiles plus restore purchases appear in the same sheet without a recommended plan or project-specific recommendation.

### Missing Next Steps

- Empty home says projects will appear but does not directly tell the user to start the first book.
- After creating a project, the next screen says `Ready for a plan`, but the larger journey from plan to preview to export is not summarized.
- After answering the last plan question, `Save answer` does not strongly indicate that `Revise with answers` is the real submission action.
- If a plan has no open questions, the screen says so but does not emphasize approval or revision as the next choice.
- After account deletion request submission, the SnackBar confirms receipt but does not explain support follow-up expectations.

### Unclear Credit Or Billing Language

- Credits are visible on home before the user knows what credits buy.
- Credit estimates for approval are large numbers without a plain-language package explanation.
- Export unlock and full generation approval both use credits, but the relationship between writing credits, export unlocks, subscriptions, and one-book purchases is not fully explained in the flow.
- Paywall local/test unavailable state mentions Play testing tracks and license tester accounts. That is useful for development but risky in production.
- Pending payments are explained, but there is no persistent billing history or subscription management path in account.

### Stale Or Ambiguous Progress

- Progress polls every 4 seconds, but the UI does not show `last updated`.
- The progress screen can display an old `initialMessage` below the current action.
- Plan polling stops when project status is no longer `planning`, but the UI does not show why it stopped.
- Project cards show progress and current action, but not the time of last activity.
- Image loading failure shows only an icon, which can look like a missing feature rather than a recoverable asset issue.

### Dead-End Empty Or Error States

- Home empty state is passive and relies on a separate panel for action.
- Shared error state uses a network-like icon for all failures, including auth, billing, missing projects, and route errors.
- SnackBar-only API errors are transient and do not create durable recovery guidance.
- Progress unavailable has retry, but it does not explain whether generation continues server-side.
- Store unavailable paywall state does not offer non-purchase next steps for normal users.

### Hidden Support, Privacy, Or Report Paths

- Auth screens do not expose support, privacy, terms, or AI disclosure.
- Home has no visible support or privacy entry except account icon.
- Report actions are available only after generated preview content appears.
- Account support and policy values are selectable text rather than obvious open/copy/contact actions.
- Project deletion is visible on project detail, while account deletion is in account. The difference is explained in copy but not reinforced across both paths.

## User-State Walkthroughs

### Brand-New Signed-Out User

1. User opens the app and is redirected to `/auth/sign-in`.
2. They can sign in or tap `Create account` to reach `/auth/sign-up`.
3. They see the Tomeza name and a short value line, but no onboarding, privacy, terms, support, or free/paid explanation.
4. Main confusion risk: the user must create an account before seeing the guided workflow or credit model.
5. Follow-up: Phase 04 should make first-run purpose and next step clearer. Phase 08 should expose trust links before account creation.

### New Signed-In User With No Projects

1. User lands on `/home`.
2. Credits load above the `Start a new book` panel.
3. Project list shows `No books yet` with passive copy.
4. Primary next action is `New`, but credits can compete for attention.
5. Follow-up: Phase 02 should prioritize first project creation and make the empty state actionable.

### User With A Draft Project And No Plan

1. User opens a project card from `/home` and lands on `/projects/:id`.
2. Header shows title, prompt, presets, and delete action.
3. No-plan card shows `Ready for a plan` and `Create book plan`.
4. After tapping, the action disables as `Plan requested` and polling begins.
5. Follow-up: Phase 05 should clarify that this creates a reviewable plan, not the full paid book.

### User With A Plan Awaiting Answers

1. User opens `/projects/:id` with a generated plan.
2. They see premise, audience, chapters, questions, revision request, and approval card.
3. They answer one question at a time, then must tap `Revise with answers` to submit collected answers.
4. They can also send a free-form revision or approve.
5. Follow-up: Phase 05 should reduce competing actions and make answer submission, revision, and approval feel like a clear sequence.

### User With Insufficient Credits

1. User taps `Approve and start writing` on `/projects/:id` or tries a locked export on `/projects/:id/handoff`.
2. App loads billing and compares available credits with estimated or required credits.
3. If short, it opens the bottom-sheet paywall.
4. Paywall shows credit balance, products, restore, pending/error states, and Play availability.
5. Follow-up: Phase 07 should explain the credit package in plain language before price and before commitment.

### User With Generation Running

1. User is routed to `/projects/:id/handoff` after approval or taps `View generation progress`.
2. Progress card shows status label, current action, percentage, pages, visuals, and backend-provided steps.
3. Preview may be empty until pages arrive. Exports remain preparing.
4. Polling refreshes every 4 seconds, but no stale-state timestamp is shown.
5. Follow-up: Phase 06 should make progress feel alive, trustworthy, and resilient to slow networks.

### User With Failed Generation

1. `/projects/:id/handoff` shows a failure message in an error-colored block.
2. If backend marks retry available, user sees `Retry generation`.
3. Retry calls the mobile resume endpoint and refreshes status.
4. If retry is not available, the failure state has no durable support or next-step path beyond refresh.
5. Follow-up: Phase 06 should separate retryable, waiting, and terminal failures. Phase 08 should connect terminal failures to support/report paths where appropriate.

### User With Export Ready

1. `/projects/:id/handoff` shows generated preview and export tiles for PDF and EPUB.
2. If unlocked, user can download and share.
3. If locked but enough credits are available, the button says `Unlock PDF` or `Unlock EPUB`.
4. If locked and credits are short, the button says `Get credits` and opens the paywall.
5. Follow-up: Phase 07 should clarify whether tapping unlock/download spends credits, what is included, and how PDF/EPUB differ.

## Privacy-Safe UX Metrics Plan

Phase 01 does not add analytics. Later implementation should use a minimal event taxonomy that measures activation, paid moments, recovery, and trust paths without collecting user content.

| Event | Trigger | Safe properties |
| --- | --- | --- |
| `sign_up_completed` | Successful account creation. | App version, platform, auth method category, locale, coarse timezone. |
| `first_project_created` | First successful project creation for account. | Book type, length preset, quality preset, visuals enabled, project count bucket. No prompt or title. |
| `plan_generated` | Plan becomes available for review. | Book type, target page bucket, visuals enabled, duration bucket, retry count bucket. No plan text. |
| `question_answered` | User saves or skips a plan question locally. | Question index, answer type `suggested`, `custom`, or `skip`, plan question count bucket. No question or answer text. |
| `revision_requested` | User submits plan answers or free-form revision. | Revision source `guided_answers` or `free_form`, plan version number bucket, character count bucket. No revision text. |
| `plan_approved` | User confirms approval and backend accepts. | Estimated credit bucket, available credit bucket, has export unlock boolean, book type, length preset. |
| `generation_completed` | Generation status reaches complete/export ready. | Duration bucket, page count bucket, visual count bucket, retry count bucket. No generated text. |
| `paywall_viewed` | Billing paywall opens. | Entry point `home`, `approval`, or `export`, credit balance bucket, product availability status. |
| `purchase_started` | User taps a product purchase button. | Product SKU, product type, entry point, price currency. No purchase token. |
| `purchase_verified` | Backend verifies purchase and grants/records result. | Product SKU, purchase status category, credits granted bucket, subscription active boolean. No purchase token, order id, or raw verifier response. |
| `export_downloaded_shared` | Download succeeds or share sheet starts. | Format `pdf` or `epub`, action `download` or `share`, unlocked before action boolean, credit spend bucket. No file path or book text. |
| `generation_retry_used` | User taps retry generation and backend accepts. | Failure stage category, retry count bucket, status after retry. No failure stack or prompt content. |
| `report_support_deletion_opened` | User opens report dialog, support/account controls, or deletion dialog. | Path category `report_book`, `report_visual`, `support`, `project_delete`, `account_delete`, route. No report comment, support message, deletion note, or generated content. |

Recommended implementation guardrails:

- Use route names and state categories, not raw URLs containing project ids.
- Use coarse buckets for credits, duration, page counts, retry counts, and character counts.
- Prefer backend-issued opaque ids only when needed for funnel stitching; hash or rotate identifiers according to the privacy policy.
- Keep debug/test analytics disabled by default unless intentionally enabled for internal QA.
- Document any future third-party SDK in Data Safety materials before production release.

## Explicit Analytics Guardrails

- Do not collect prompt text.
- Do not collect generated book text.
- Do not collect purchase tokens.
- Do not collect raw sensitive user content.
- Do not collect plan question text, custom answer text, revision request text, report comments, deletion notes, support message bodies, file paths, raw entitlement records, raw backend errors, or internal generation metadata.
- Do not expose provider, model, temperature, queue, raw entitlement, or backend status language to users.
- Keep generation, ownership, billing verification, credits, entitlements, safety, and asset access authoritative on the backend.

## Prioritized UX Risks For Phases 02-08

| Priority | UX risk | Why it matters | Recommended phase |
| --- | --- | --- | --- |
| P0 | Home does not rank projects by required next action. | Returning users may not know whether to review, approve, wait, retry, or export. | Phase 02 |
| P0 | Credit/export language is visible but not yet intuitive. | Users may hesitate at paid moments or misunderstand what credits buy. | Phase 07 |
| P1 | Plan review has too many competing actions. | Users can answer, skip, revise, approve, refresh, or delete without a clear sequence. | Phase 05 |
| P1 | Progress can feel stale or ambiguous. | Long-running generation needs trust, especially when preview/export data is partial. | Phase 06 |
| P1 | Empty and error states are generic. | New users and failed states need recovery paths, not passive or network-only messages. | Phase 02, Phase 03, Phase 06 |
| P1 | Auth lacks first-run trust and product context. | Users are asked to create an account before seeing privacy, support, and free/paid expectations. | Phase 04, Phase 08 |
| P2 | Support, privacy, report, and deletion paths exist but are not always actionable or discoverable. | Trust controls need to be easy to find before and after something goes wrong. | Phase 08 |
| P2 | Dense rows, chips, and bottom actions may degrade at large text sizes. | Credits, wizard choices, plan questions, progress, and export actions are all wrap-heavy. | Phase 03 |
| P2 | Wizard choices do not preview downstream cost/time impact. | Users choose length, finish, and visuals without knowing how these affect approval and exports. | Phase 04, Phase 07 |
| P2 | Development or placeholder wording can leak in production. | Play testing and placeholder policy/support values would reduce trust if production config is incomplete. | Phase 07, Phase 08 |

## Smallest Useful Test-Gap List

These are the smallest later-phase test additions that would protect the highest-risk UX changes.

1. Home empty state with no projects, no credits loaded yet, and large text scale. Assert the first-book action remains visible and actionable.
2. Home with mixed project statuses: draft, plan ready, generating, failed, and export ready. Assert the highest-priority next action is visible.
3. Auth sign-up with future privacy/support links and API failure. Assert durable error copy and trust links remain visible at large text scale.
4. Wizard back/forward preservation and final summary, once Phase 04 adds clearer review/cost context.
5. Project detail no-plan, planning, plan-with-questions, no-question, revision-busy, insufficient-credit, and approved states. Assert only one dominant next action per state.
6. Plan question flow at large text scale with long suggested answers. Assert chips wrap without clipping and answer submission remains obvious.
7. Generation progress stale, slow, failed-retryable, failed-terminal, preview-empty, preview-with-images, and image-unavailable states. Assert recovery or support guidance appears where expected.
8. Export locked with enough credits, locked with insufficient credits, unlocked, download failure, and share failure. Assert credit spend language is explicit before paid actions.
9. Paywall store unavailable, missing products, pending purchase, canceled purchase, and verification failure. Assert production-safe copy and restore remain available.
10. Account support/privacy/deletion controls with long URLs, configured production URLs, deletion success, and deletion failure. Assert controls are actionable and copy distinguishes project deletion from account deletion.
