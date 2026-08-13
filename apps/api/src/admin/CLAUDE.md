# Admin

Metrics and inspection queries behind `/api/admin`. The operator dashboard at `/admin` in
`apps/web` is the only consumer; nothing in the Flutter app reaches any of this.

`costBreakdown.ts` partitions provider spend, `operationEconomics.ts` attributes it to charges,
`pricingDrivers.ts` and `metrics.ts` do the aggregate reporting.

Everything here is a *sum over `ProviderCallLog`*, and the invariants below are all about which
rows may be summed together. The rule that governs the whole directory: **billed and unbilled must
add up.** Spend that cannot be attributed to a charge is reported as unbilled, split by reason —
never netted into a margin, and never dropped. A dashboard that quietly discards rows understates
real spend, which is the one error mode that matters here.

`VOICE_CALL_MINUTE` shows a 100% margin honestly and wrongly, because the app holds its own socket
to Gemini and that spend never reaches our logs. That is what `OPERATION_NOTES` is for; add a note
rather than inventing a cost.

## Reading the provider call log

- **A non-null `ProviderCallLog.costHint` *is* a settled, priced call.** Provisional, in-flight and
  failed rows all write `null` (`apps/worker/src/providers/usageAccounting.ts`), so real provider
  spend is `SUM("costHint")` — do not replay the rate cards in `packages/core/src/costs.ts` to
  aggregate it. Rows the rate card could not price are counted separately rather than dropped, so
  the total is never quietly short. `calculateProjectCostSummary` still recomputes per project,
  because it also folds in image costs from `ImageAsset` when the log side is thin.
- **A costless call has four different causes and the Costs tab splits all four.**
  `apps/api/src/admin/costBreakdown.ts` partitions every logged call into priced + failed +
  in-flight + estimated + unrated, because only `unratedCalls` — settled on real tokens that no rate
  card could price — means the dashboard is *understating* real spend; the other three are
  nothing to fix. Usage is summed over priced calls only, so tokens and dollars always describe the
  same set of calls and a missing rate card cannot flatter the tokens-per-dollar figures. Unrated is
  a text-only signal by construction: `recordProviderImageCost` and `recordProviderAudioCost` return
  early rather than write a row they cannot price, so an unpriced image model leaves no trace at all.

## Attribution and revenue

- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it
  three ways.** `apps/api/src/admin/operationEconomics.ts` reads the charge off the job's *payload*
  (`billingLedgerEntryId`) — not `CreditLedgerEntry.generationJobId`, which is set on a minority of
  entries and loses most of the spend — then walks `planId` to reach the fan-out children a run
  charged for, then falls back to a `JobType → CreditOperation` map **gated on operations the
  project was actually charged for**. That gating is the whole safety property: an operator-console
  book has no charge, so its jobs stay unbilled instead of inventing revenue. Whatever is left is
  reported as unbilled spend split by reason, never netted into a margin and never dropped — the
  two must add up to the Costs tab's total. `VOICE_CALL_MINUTE` shows 100% margin honestly and
  wrongly, because the app holds its own socket to Gemini; that is what `OPERATION_NOTES` is for.
- **"Revenue" is two different numbers and the dashboard shows both.** Cash collected
  (`PurchaseRecord.amountMicros`) is money banked in the window; credits delivered × the credit
  rate is the value of work actually done. They diverge because a reader buys on one day and spends
  over the next month, so pairing either alone against provider spend misstates the margin.
