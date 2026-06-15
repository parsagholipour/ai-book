# Phase 06 Output Notes

## Completed

- Added backend billing models for product catalog entries, user credit accounts, credit ledger entries, user entitlements, purchase records, and subscription states.
- Added deterministic credit pricing helpers and provider-cost/margin estimates in `packages/core`.
- Added atomic credit operations for grants, reservations, commits/spends, refunds/releases, and project entitlement grants.
- Added mobile-visible `/api/mobile/billing` so signed-in users can see credit balance, active entitlements, product assumptions, and credit costs.
- Added mobile credit gates for full generation / plan approval and export downloads.
- Added failed/stopped generation refund behavior for paid full-generation project operations.
- Added operator project `billing` summaries with estimated credits, estimated provider cost, actual provider cost, and margin estimates while preserving existing `cost` and `tokens` fields.

## Pricing And Credit Assumptions

- Credits are integer units. The launch accounting assumption is `1 credit = USD 0.01`.
- One standard export credit is `1,000 credits`.
- Plan generation is currently free: `0 credits`.
- Limited preview generation is reserved for a future endpoint and currently costs `0 credits`.
- Full book generation uses `350 base credits + 8 credits per target page`.
- Interior image generation costs `45 credits` per estimated interior image.
- Cover regeneration costs `120 credits` when exposed as a separate paid action.
- Premium review / premium best-of drafting costs `200 credits`.
- PDF/EPUB export unlock costs `150 credits`.
- A standard 28-page workbook with six interior visuals estimates to `994 credits`, keeping the default launch package inside one standard export credit.

## Ledger And Entitlement Decisions

- `UserCreditAccount` stores atomic available/reserved counters; `CreditLedgerEntry` stores the audit trail and idempotency keys.
- Costly mobile operations reserve credits first, then commit the reservation after server-side state updates and before enqueue.
- Duplicate idempotency keys return the original ledger entry and do not double-spend.
- Full-generation purchase grants a project-scoped `EXPORT_UNLOCK` entitlement so PDF and EPUB downloads do not charge again.
- Mobile export download requires an active export entitlement; legacy/generated projects without one may spend the standalone export unlock once.
- Failed or stopped paid generation refunds the latest full-generation ledger entry for that project and revokes entitlements tied to the refunded ledger entry.
- Google Play purchase verification is intentionally a placeholder for later phases: purchase and subscription records can store provider IDs/tokens, but no client billing flow was implemented here.

## Known Follow-Ups

- Phase 07 may show `/api/mobile/billing` in the Flutter billing/account state, but should not implement Google Play Billing yet.
- Future Google Play work should verify purchases server-side, then grant credits through the same ledger operations.
- A dedicated mobile unlock endpoint may be useful before Phase 10 if the UI should confirm export spending before starting a download.
- Cover regeneration and premium add-ons now have costs, but separate mobile endpoints for those add-ons are still future work.

## Validation

- `pnpm db:generate`
- Focused checks run before full validation:
  - `pnpm --filter @book-maker/db typecheck`
  - `pnpm --filter @book-maker/api typecheck`
  - `pnpm --filter @book-maker/worker typecheck`
  - `pnpm --filter @book-maker/core test -- src/billing.test.ts`
  - `pnpm --filter @book-maker/db test -- src/billing.test.ts`
  - `pnpm --filter @book-maker/api test -- src/mobileProjects.test.ts`
- Full validation:
  - `pnpm typecheck`
  - `pnpm test`
