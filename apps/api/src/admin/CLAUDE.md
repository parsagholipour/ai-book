# Admin

Metrics and inspection queries behind `/api/admin`. The operator dashboard at `/admin` in
`apps/web` is the only consumer; nothing in the Flutter app reaches any of this.

`costBreakdown.ts` partitions provider spend, `operationEconomics.ts` attributes it to charges,
`pricingDrivers.ts` and `metrics.ts` do the aggregate reporting. `spendToday.ts` ranks today's
spenders for the AI spend panel (`/api/admin/spend-controls`, `../routes/adminSpendControls.ts`),
summed exactly as the spend breaker sums a reader's cap (`../spendBreaker.ts`).

Everything here is a *sum over `ProviderCallLog`*, and the invariants below are all about which
rows may be summed together. The rule that governs the whole directory: **billed and unbilled must
add up.** Spend that cannot be attributed to a charge is reported as unbilled, split by reason —
never netted into a margin, and never dropped. A dashboard that quietly discards rows understates
real spend, which is the one error mode that matters here.

A margin that still cannot see part of its spend gets a note in `OPERATION_NOTES` rather than an
invented cost. `VOICE_CALL_MINUTE` is the one carrying one: relayed calls are costed now (below),
but calls from before that, and any made on a direct provider token, are not.

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
  a text signal plus one audio one: `recordProviderImageCost` and `recordProviderAudioCost` return
  early rather than write a row they cannot price, so an unpriced image model leaves no trace at all,
  but a voice call's usage the Live rate card cannot price is written unpriced (`costHint` null,
  `costStatus: "unknown_rate"`) because those tokens were billed and dropping them would understate.
- **A grounded search's `costHint` includes only the grounding fee Google bills, decided by the
  prompt's ordinal in its pool's free allowance when the row is written.** Google bills Grounding
  with Google Search per grounded prompt (2.5) or per search query (3.x) on top of tokens, and
  waives the first 1,500 prompts a Pacific-time day (2.5 Flash and Flash-Lite together; 2.5 Pro
  has its own) or 5,000 queries a month (3.x) per Google project. Every recorder — each worker and
  the API's creation chat — claims the call's ordinal from `SearchGroundingAllowanceCounter` in the
  transaction that writes its row, and prices it free inside the allowance and at list past it
  (`packages/core/src/adapters/CLAUDE.md`). So `metadata.groundingFeeUsd` is a fee actually billed,
  it is already inside `costHint`, and the rule above holds unchanged: a non-null `costHint` is a
  settled, priced call, and nothing here nets anything out after the fact. Pricing every prompt at
  list was tried first and is the reason for this: it recorded $12.78 on a dev day Google billed
  nothing for. `searchGrounding.ts` breaks the fee out per allowance period — units used against
  the allowance they were priced under, the free ones, the billed fee and the fee at list — and the
  Costs tab shows exactly that. **The allowance it was priced under is a setting, not Google's
  number**: the counter sees only calls this system logs, while Google's pool also counts every
  other holder of the key, so production sharing a key sets `SEARCH_GROUNDING_FREE_*` lower, and 0
  means list price always. Each row records its `groundingAllowance`, so the table shows what each
  period was priced under even after the setting changes. A grounded row on a model with no
  grounding rate has a null `costHint` and counts as unrated, never as priced on its tokens alone.

- **Every provider call row names the user it was spent for, and a voice call's usage is recorded
  from the provider's own token counts.** A per-reader daily cost cap is a `SUM("costHint")` over
  `ProviderCallLog.userId` (`providerSpendSince`, `@book-maker/db/providerSpend`), and the log used
  to name only a book and a job, so a reader's spend was a join through `Project` that missed every
  call with no book: the library portrait, the creation chat and the book advisor, a library
  character's voice call. Every writer now stamps `userId`. The worker reads it off the delivery's
  async context (`apps/worker/src/runtime/providerSpendUser.ts`) — the book's owner, looked up once
  per delivery, or the portrait job's payload user — because the logging adapters are built
  synchronously deep in every handler and no constructor of theirs can wait for a query. The API's
  inline wrappers take it as a *required* `InlineUsageContext.userId`, so a new call site has to say
  whose spend it is; operator-console calls pass null. Voice calls were invisible outright: the
  relay (`apps/api/src/mobile/voiceRelayConnection.ts`) is the only process that sees Gemini Live's
  `usageMetadata`, so it meters every report into `VoiceUsageMeter`
  (`apps/api/src/mobile/voiceRelayUsage.ts`) and writes a `purpose: "voice-call"` segment at least
  once a minute and at stop. Live bills every turn for the whole context window, so the call's spend
  is the **sum** of its reports — never the last one, which undercounts by roughly the number of
  turns — priced by modality off Google's published Live rates (`packages/core/src/liveVoiceUsage.ts`,
  source and date beside the table). The meter is emptied before any write is awaited, so a report
  rides exactly one segment across the periodic flush, the stop and a provider resume, and a failed
  write is logged and lost rather than retried into a duplicate. Voice rows are `audio` in every
  query that groups by kind (`providerCostKindSql`, one spelling for all four), which is why the
  Costs tab calls that bucket Audio rather than Narration. These rows are also the only measurement
  the 15-minute call cap and the in-call compaction will ever get: both were sized on a model of a
  busy call ($0.14–0.17 a minute against $0.25 of revenue at the cheapest credit; `packages/core/CLAUDE.md`,
  "Voice calls"). Read `VOICE_CALL_MINUTE`'s margin on the Operations tab in the first week before
  moving the price, the cap or the compaction.

## Attribution and revenue

- **Nothing joins a provider call to the charge that paid for it, so the Operations tab derives it
  four ways.** `apps/api/src/admin/operationEconomics.ts` reads the charge off the job's *payload*
  (`billingLedgerEntryId`) — not `CreditLedgerEntry.generationJobId`, which is set on a minority of
  entries and loses most of the spend — then walks `planId` to reach the fan-out children a run
  charged for, then falls back to a `JobType → CreditOperation` map **gated on operations the
  project was actually charged for**. That map is one-to-one for every job type but
  `APPLY_BOOK_EDIT`, which is four operations wearing one name: `billingOperationForIntent`
  (`apps/api/src/mobile/bookEditPricing.ts`) charges a structural insert as `PAGE_REGENERATION` and
  a chat-added picture as `IMAGE_GENERATION`, so that arm reads `payload.intentKind` and is
  *generated* from that function rather than restated — a hand-written copy is a thirteenth list to
  keep in step, and the failure it produces is paid model spend reported as unbilled. The gating is
  the whole safety property of the third path: an operator-console
  book has no charge, so its jobs stay unbilled instead of inventing revenue. The fourth path is the
  voice relay's: its rows have no job, but each names its call (`metadata.voiceCallId`) and every
  minute hold the call settled names it too (`metadata.callId`), so a charged call's spend lands on
  `VOICE_CALL_MINUTE` and an uncharged one stays `UNBILLED_INLINE`. Whatever is left is
  reported as unbilled spend split by reason, never netted into a margin and never dropped — the
  two must add up to the Costs tab's total. `VOICE_CALL_MINUTE`'s note says which calls it still
  cannot see. A source read — the worker summarising or OCRing a reader's uploaded file
  (`purpose` `source-summary` / `source-ocr`, `SOURCE_READING_PURPOSES`) — names a reader but no job
  and no book, and its admission charge is a `CHAT_MESSAGE` no call is linked to, so it has its own
  bucket, `UNBILLED_SOURCE_READING`, rather than reading as the API's inline calls.
- **"Revenue" is two different numbers and the dashboard shows both.** Cash collected
  (`PurchasePayment.amountMicros` less its cumulative `refundedAmountMicros`, by `paidAt`) is
  recorded payments in the window; credits delivered, valued by source (next entry), is the value
  of work actually done. They diverge because a reader buys on one day and spends
  over the next month, so pairing either alone against provider spend misstates the margin.
  A payment is one paid order; `PurchaseRecord` tracks a token's current state and spans renewals.
  Expiry and cancellation leave payments intact. Overview totals, daily series and user cash all
  read payments. Prices are catalog snapshots, not Play settlement amounts; legacy backfill is
  marked `legacy_catalog_estimate`. See `docs/google-play-rtdn.md` for migration and date semantics.
  `amountMicros` is the USD catalog price *before Google's fee*, so the Overview shows it as gross
  beside the net (`cashRevenue.ts`): less `PLAY_SUBSCRIPTION_FEE_RATE` on a subscription and
  `PLAY_ONE_TIME_PRODUCT_FEE_RATE` on anything else, both in core `billing.ts` — 15% on packs holds
  only while the developer account is enrolled in Play's 15% service-fee tier, else set it to 0.3.
  The cash margin is net cash less provider spend. The same rows give the revenue-by-currency
  table from `localPriceMicros` / `localCurrency` / `localPriceSource` (migration 000104): summed
  per currency, never converted (nothing here has an exchange rate), refunds taken pro rata, and
  orders with no local price on a row of their own. Those columns never decide anything. User
  cash in the inspector (`inspection.ts`, `loadUserPayments` through `summarizePayments`) is net of
  Google's fee too, with the gross beside it, and so are the growth funnel's per-SKU and
  per-country cash (`growthMonetization.ts`) and the user list's Paid column (`listAdminUsers`
  sums the same clamped refunds in SQL, with core's two `playServiceFeeRate`s passed in as
  parameters, and sorts "Money paid, net" by it; `cashUsd` stays the gross beside `cashNetUsd`).
- **A credit is valued by where it came from, net of Google's fee, and a welcome credit is worth
  nothing.** Every figure that turns credits into dollars — the Overview's delivered value, refunds
  and outstanding credits, the Operations tab, both generated-book and generated-plan lists and the
  project inspector — comes from `creditValuation.ts`. It used to be credits × `CREDIT_USD_VALUE`
  ($0.01): no credit is sold at a cent (a plan credit nets $0.0021–0.0028, a pack credit
  $0.0064–0.0068), so every margin read 3.5–4.7× too rosy and a free reader's welcome-credit book
  read as income (launch review, 2026-10-13). A charge's allowance share (`planCreditsDelta`) is
  worth the per-credit value of the reader's latest allowance grant at or before it — catalog price
  × (1 − fee) ÷ the period's credits, an intro period at its own offer's price and credits
  (`introOfferForGrant`), a prorated switch at its plan's full-period rate, a legacy free
  allowance at $0. Its bought-pool share is laid end to end, oldest grant first, after everything
  that reader's earlier charges took from the pool (a SQL running sum over their whole charge
  history): welcome and operator grants are $0 lots, a pack is a lot at its net rate, a store
  refund's reversal takes its credits out of the lot, and pool credits beyond every grant (an
  allowance refunded after its period ended) take the reader's latest paid rate. So a reader who
  spends their welcome credits and then buys a pack is valued at the pack's rate from then on, and
  a reader who never paid is worth $0 however much they spend — which is also why only readers with
  a purchase-linked grant are read at all. A refunded charge keeps its blended rate: the kept part
  is delivered, the rest is reported as refunded at the same rate. It values at catalog prices, so
  a later price change revalues earlier grants of that product. `creditValuationSummary` sends the
  rate table and a one-sentence method with every response the console prints it beside. Never
  multiply credits by `CREDIT_USD_VALUE` here; a projection with no ledger behind it uses
  `CHEAPEST_PAID_CREDIT_USD_VALUE` — which is what `/api/admin/pricing` sends the console as
  `creditUsdValue`, so the pricing editor's "Gross profit at these prices" and its preview's "≈ $"
  are labelled "at the cheapest paid credit, net of Google" (`routes/adminPricing.ts`,
  `apps/web/src/features/pricing/ProfitSection.tsx`). `creditValuation.test.ts` holds the representative ledgers
  (free, Creator, intro, pack buyer, mixed, refunds, store refund, overflow).
- **A reversal is an amount, not a boolean.** A page-priced operation can return only the part it
  did not deliver. Revenue, project/user inspection, pricing coverage and operation economics read
  the cumulative REFUND amount and subtract it from the original SPEND; `reversedByEntry` merely
  says that some refund exists. Provider spend remains attributed to the attempt that incurred it.

## The growth funnel

- **The funnel reads the tables the product already writes; it adds only what the server cannot see.**
  `productFunnel.ts` (the Overview's `growth` block) follows the readers who signed up in the window:
  a plan is a succeeded `PLAN_GENERATION` attempt, a delivered book a succeeded
  `FULL_BOOK_GENERATION` attempt (marked at publication), a payment a `PurchasePayment`. Two tables
  exist for it alone: `ProductEvent` (a paywall the app showed, posted to `POST /api/mobile/events`
  with a trigger from a closed list) and `UserActiveDay` (one row per reader per UTC day, written at
  sign-in, signup and token refresh — `src/productAnalytics.ts`). Retention is rolling ("used the
  app on day N or later") and starts counting the day `UserActiveDay` was deployed, so earlier
  cohorts read low rather than wrong. The operator console's `local-admin` user is never a reader.
- **An app event says what kind of thing happened and nothing a reader wrote, and a completed
  purchase is never one.** `ProductEvent` names are a closed list (`PRODUCT_EVENT_NAMES`,
  `src/productEventNames.ts`): `paywall_viewed`, `purchase_started` / `purchase_cancelled` /
  `purchase_failed` (the launch review's missing checkout half, 2026-10-13) and
  `install_attributed`. `POST /api/mobile/events` takes one flat body (`mobile/productEventBody.ts`
  — a `oneOf` would be mangled by Ajv's `removeAdditional`) whose every field is a closed list or a
  narrow pattern: a SKU, a paywall trigger as the checkout's `surface`, a failure *class* from
  `PURCHASE_FAILURE_REASONS` (never Play's or the server's message), referrer fields normalised to
  `[a-z0-9._-]{1,40}`, a share slug; a field the event does not name is dropped before it is
  stored, so the raw referrer cannot arrive. Completion is the `PurchasePayment` row — the checkout
  funnel (`growthAcquisition.ts`) counts starters who paid for that SKU between their first start and
  a day after their last. The app reports a checkout's start and pre-launch failures from
  `BillingController.buy` and how Play answered from `PlayPurchaseProcessor` alone, which hears each
  answer once however many purchase surfaces are open; a restore or a background pass is never a
  checkout (`apps/mobile/CLAUDE.md`). `growthAcquisition.test.ts`, `mobile/productEvents.test.ts`.
- **An install is attributed by its first report, which only exists once a reader signs in.** The
  app reads the Play install referrer once per install and posts `install_attributed` after the
  first sign-in on that install; there is no event for an install nobody signed in to, and no
  column on `User` — the reader's earliest report *is* the first touch, and the 400-day event prune
  bounds how far back it reaches. The install-source table counts reports in the window
  (reinstalls and second devices included) beside first-touch readers, those of them who signed up
  within a day before it (`newAccounts`), came through a share page and have paid.
- **Intro conversion is a later full-price subscription payment by the same reader; churn is a
  reader who held a paid plan as a UTC month opened and none as it closed.** Both read billing rows
  only (`growthMonetization.ts`). An intro payment is `amountSource` `intro_offer` (or
  `catalog_snapshot_unknown_offer`); it converts on any later subscription payment that is not an
  intro or a trial and was not refunded in full — a renewal on its token or a switch to another plan,
  which is a new token. It counts only once `INTRO_RENEWAL_DUE_DAYS` (38: a month plus Play's grace
  period) have passed, so the rate is renewed ÷ due. Churn reads the paid-plan entitlements
  (`source = 'google_play_subscription'`; an operator grant is no subscriber), one row per held plan
  extended in place at each renewal: an ACTIVE row covers every instant from its start, because the
  renewal may simply not be recorded yet, and an EXPIRED or REVOKED row ends at its `expiresAt`. A
  reader is the unit, so an upgrade (one row ends as the next begins) is not churn, and a REVOKED
  end is counted as refunded. The current month says "so far". That read scans `UserEntitlement`,
  the export unlocks written before 2026-10-15 included — fine at launch scale; a `(type, startsAt)`
  index when it is not.
  Revenue by country groups the window's payments by the buyer's signup country
  (`WelcomeCreditGrant.countryCode`, never updated at login) and reuses `summarizePayments`, so its
  net and its local-currency split are the Overview's arithmetic. `growthMonetization.test.ts`.
