# Effort-Based Planning Charges

Status: Implemented  
Origin: implementation of initial-plan billing at the selected effort tier

## Objective

Charge the first plan at the book's selected effort when planning starts, without a dedicated billing dialog. The later book-generation package remains a separate charge, confirmed only after the reader approves the plan.

Compiled defaults:

| Effort | Price key | Credits |
| --- | --- | ---: |
| Quick draft | `planGenerationFast` | 20 |
| Balanced | `planGeneration` | 40 |
| Extra polish | `planGenerationPremium` | 80 |
| Ultra effort | `planGenerationUltra` | 120 |

The unsuffixed `planGeneration` key is the Balanced rate, matching every other tiered price in the table.

## Definitions

- **Initial plan generation:** Creating the first plan for a project. Mobile entry points are creation-chat Build and direct project planning (`POST /api/mobile/projects/:id/plan`). The ledger operation is `PLAN_GENERATION`.
- **Plan revision:** Reworking an existing plan before approval. Flat `planRevision` (default 40). Unchanged by this spec.
- **Book replan:** A structural replan of a finished book. Flat `bookReplanBase`. Unchanged by this spec.
- **Book-generation package:** The `FULL_BOOK_GENERATION` quote charged at plan approval (`estimateFullBookCreditCost` / `estimateProjectCredits`). Unchanged by this spec except that surfaces must present it as a later charge, not as the Build price.
- **No confirmation:** No dedicated billing dialog for the initial-plan charge. Page-count and visual-selection prompts may still run; they are not billing dialogs.

## Requirements

### PRICE-1: Four operator-editable plan-generation rates

The pricing table must include `planGenerationFast`, `planGeneration`, `planGenerationPremium`, and `planGenerationUltra`. All four belong in `TIER_PRICED_KEYS` via the base key `planGeneration`, in `CREDIT_PRICING_LIMITS`, and on the Admin Pricing form under Making a book.

Zero remains a valid operator-configured price after migration, so any planning tier can later be made free.

### PRICE-2: One resolver for the initial-plan quote

Core must expose `planGenerationCreditCost(input, pricing?)`. It resolves `modelTier` from the create-project input (Balanced when none is stored), names the price key with `tierPriceKey("planGeneration", tier)`, and returns `{ credits, modelTier, pricingKey }`.

Both mobile initial-plan entry points must charge through this function. `creditCostForOperation("PLAN_GENERATION")` stays the Balanced-only lookup and must not be used to price a tiered first plan.

### CHARGE-1: Charge when planning starts

The reservation happens when the initial-plan attempt is created, not at plan approval. Approving a plan must not charge `PLAN_GENERATION` a second time.

### CHARGE-2: Preserve the existing money loop

Keep reserve → commit → refund, command-key idempotency, insufficient-credit 402 with no project/job/ledger writes, cancellation refund, and failure refund. Stamp `modelTier` and `pricingKey` into ledger metadata for audit and revenue projection.

### CHARGE-3: Operator-only planning stays uncharged

Legacy operator `PLAN_BOOK` routes must not start charging because mobile planning now does.

### MIGRATE-1: Append a pricing revision for existing installations

Migration `000061_tiered_plan_generation_pricing` must append a head revision rather than rewrite history:

- A stored Balanced rate of 0 (the legacy compiled free rate) becomes 40.
- A stored nonzero Balanced rate is an operator override and is preserved.
- The three new tier keys are seeded at 20 / 80 / 120.
- An empty `CreditPricingRevision` table stays empty; those installs read the new compiled defaults.

### ANALYTICS-1: Attribute plan revenue by stamped key

Pricing drivers must count `PLAN_GENERATION` spend against the stamped `pricingKey` when it is one of the four plan-generation keys. Otherwise fall back to the project's stored tier, then Balanced for a project-less legacy row.

### ADMIN-1: Four fields, live save/revert, tiered preview

Admin Pricing shows the four plan-generation fields with compiled defaults, live save/revert, and the same validation ceilings as the other flat charges. The worked-example preview quotes each effort as:

planning charge + later book-generation package = total reader journey

### MOBILE-1: Split the two charges in the UI

The app mirrors live rates through `estimatePlanGenerationCredits` (Dart twin of `planGenerationCreditCost`). Surfaces that quote before a plan exists must separate:

- **Plan now** — the immediate initial-plan price.
- **Book after approval** — the later package.

Show the immediate plan price on the Build action, Effort choices, and the expanded estimate. Page-count and visual-choice prompts may still show a package estimate; that copy must say the package is charged only after plan approval.

### MOBILE-2: Planning paywall, no side effects

If Build or direct planning lacks credits, open the paywall with planning-specific wording. The API must reject with `INSUFFICIENT_CREDITS` before creating a project, output, job, or ledger row.

### RETRY-1: Skip confirmation only for initial-plan recovery

Recovery quotes include `requiresConfirmation`. It is `false` only when the resumable attempt's operation is `PLAN_GENERATION`. Full-book and plan-revision retries keep confirmation. Older clients treat a missing field as `true`.

The status read that feeds the quote must select `operation`. Dropping that column makes every retry look like a full-book charge.

Tapping Retry on an initial plan uses the refunded attempt's exact quoted price immediately. The retry token remains required for stale/replay protection even when no dialog is shown. The Retry plan action displays that price.

## Non-goals

- Do not tier plan revisions or book replans.
- Do not remove page-count or visual-selection prompts.
- Do not add a server quote route for the Dart estimate; the two implementations stay in lockstep by test.
- Do not charge operator-only legacy planning.
- Do not raise a stored zero after migration if an operator later sets a tier to zero on purpose.

## Acceptance Criteria

1. Fast / Balanced / Extra polish / Ultra initial plans reserve 20 / 40 / 80 / 120 and stamp `planGenerationFast` / `planGeneration` / `planGenerationPremium` / `planGenerationUltra`.
2. A project with no stored tier is quoted and charged as Balanced.
3. Live and explicit pricing overrides move the quote; `planGenerationCreditCost` is the only initial-plan reader of those keys.
4. Creation-chat Build and direct project planning both charge; a replay of the same command does not charge or queue twice.
5. Insufficient credits answer 402 and leave project, draft, job, and ledger untouched.
6. A failed or stopped initial plan refunds the stamped reservation (or the latest `PLAN_GENERATION` charge when the payload has no stamp).
7. Plan approval charges only `FULL_BOOK_GENERATION`. Copy on that confirmation states planning is not charged again.
8. An existing install with Balanced 0 migrates to 40 and seeds the three new keys; a nonzero Balanced override is kept; an empty pricing table stays empty.
9. Admin save/revert accepts the four fields; preview totals are plan + book package per tier; drivers attribute stamped Ultra even when the project row now says Fast.
10. Effort tiles, Build, and the expanded estimate show Plan now vs Book after approval. Visuals and page-count prompts keep their package estimate and say it is charged after approval.
11. A short-credit Build opens the planning paywall and does not call through to project creation.
12. An initial-plan recovery quote has `requiresConfirmation: false` and the Retry plan control shows the quoted credits without a billing dialog. Full-book and plan-revision retries still confirm. A quote missing the field defaults to confirm on the client.

## Verification Commands

```bash
pnpm -F @book-maker/core exec vitest run src/creditPricing.test.ts
pnpm -F @book-maker/db exec vitest run src/tieredPlanGenerationPricingMigration.test.ts
pnpm -F @book-maker/api exec vitest run src/mobile/creationSessionBuild.test.ts src/mobile/creditTierPricing.test.ts src/mobile/generationRetryQuote.test.ts src/projectStatus.test.ts src/mobile/projectStatusDto.test.ts src/routes/adminPricing.test.ts
pnpm check:mobile
pnpm check
```

The repository-wide size check has pre-existing failures in oversized worker/core files. This change must not introduce a new oversized production file.
