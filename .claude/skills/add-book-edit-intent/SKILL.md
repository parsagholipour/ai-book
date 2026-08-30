---
name: add-book-edit-intent
description: Use when adding or changing a conversational edit in the finished-book chat — a new `BookEditIntentKind` (alongside `page_rewrite`, `local_patch`, `back_matter`, `chapter_heading`, `add_image`, `move_image`, `remove_image`, `restructure_pages`, `continue_book`, `book_replan`), a new `editTarget` in `decideActionSchema`, a new `DecideAction`, or a change to how a request is priced, proposed or applied. The router lives in apps/api/src/bookEditIntent.ts (`classifyProjectChatMessage`, `normalizeIntentForStage`, `forcedDecision`, `PROPOSAL_GATED_EDIT_KINDS`) and the apply side in apps/api/src/mobile/bookEditIntents.ts (`handleProjectChatIntent`, `proposeBookEdit`) — two different ~900-line files whose names differ only by a plural. Reach for it on "make the chat understand X", "the chat quoted 960 credits to change a heading", "it keeps asking the same question", "the edit should be free", or "the proposal card says the wrong thing".
---

# Adding or changing a book-edit intent

The finished-book chat is a router (message → `BookEditIntent`), a proposal layer (intent → priced
card, or a free apply), and an execution layer (Apply → charge → job). A new intent has to be
recognised, routed, priced, proposed, applied and — critically — *reachable*, because two
mechanisms in the router exist specifically to force unresolved requests into a whole-book
`page_rewrite`.

Reasoning behind the clarification budget, the proposal gating and the free presentation edits lives
in [`apps/api/src/mobile/CLAUDE.md`](../../../apps/api/src/mobile/CLAUDE.md). Read it first — the
rules below are the *procedure*, not the justification.

## The singular/plural trap

Two files, both around 900 lines, both about edit intents:

- `apps/api/src/bookEditIntent.ts` — **singular**. The router. Types (`BookEditIntentKind`,
  `BookEditIntent`), `classifyProjectChatMessage`, `intentFromDecideAction`,
  `intentFromProposeEdit`, `normalizeIntentForStage`, `forcedDecision`.
- `apps/api/src/mobile/bookEditIntents.ts` — **plural**. The apply side.
  `handleProjectChatIntent`, `proposeBookEdit`, `applyOrCancelEditProposal`,
  `editProposalMessage`, `editProposalSummary`, `operationQueuedMessage`.

Free-standing recognisers pair the same way: `apps/api/src/bookEditBackMatter.ts` (recognise) with
`apps/api/src/mobile/backMatterEdits.ts` (apply), and `apps/api/src/bookEditChapterHeading.ts` with
`apps/api/src/mobile/chapterHeadingEdits.ts`. Check which half you are in before grepping.

Supporting leaves: `apps/api/src/bookEditMessage.ts` (reading a message — pages, quotes, scope,
languages; imports types back from the router but never values), `apps/api/src/bookEditHeuristics.ts`
(the model-free classifier), `apps/api/src/bookEditRouterPrompt.ts` (`decideActionsFor`,
`decideActionSchema`, the prompt lines), `apps/api/src/bookEditImage.ts` and
`apps/api/src/mobile/addImageTargets.ts` / `imageLayoutTargets.ts` (the image intents).

## Step 1 — decide what kind of edit this is

**Free presentation change?** If it alters how the book is *printed* and not one character of
`Page.markdown` — the Sources list, chapter headings — it is one `mediaSettings` field plus a
recompile, through `applyPresentationPreference` in `apps/api/src/mobile/presentationEdits.ts`. No
`BookEditOperation`, no ledger entry, no proposal card. The recompile is queued
`presentationOnly: true`, which sets `PRESENTATION_ONLY_RECOMPILE` on the payload — that flag is
what stops a deterministic-only report erasing the book's real quality verdict.

**Charged edit?** Then it needs an entry in `PROPOSAL_GATED_EDIT_KINDS` (see step 3), a cost in
`bookEditCreditCost` and a `CreditOperation` in `billingOperationForIntent` /
`operationKindForIntent` (`apps/api/src/mobile/bookEditPricing.ts`), a proposal card, and a queue
function built on `queueAttemptChatOperation` (`apps/api/src/mobile/editOperations.ts`). That
helper keeps the charge, durable job and edit state in one `startGenerationAttempt` transaction,
then dispatches after commit. Use the `add-priced-operation` skill for the money half.

**Answer-only?** Then it never reaches the edit machinery at all.

## Step 2 — recognise it, and mind where you return

`classifyProjectChatMessage` runs, in order: free-recogniser fast paths → `classifyWithHeuristics`
(only `show_content` and `undo_last_edit` skip the model) → `routeWithToolAgent` →
`normalizeIntentForStage`.

**A deterministic recogniser must return before `normalizeIntentForStage`.** This is the single most
important sequencing rule in the file, and it is why `backMatterIntentFromMessage` and
`chapterHeadingIntentFromMessage` are called where they are. `normalizeIntentForStage` can hand a
request to `forcedDecision`, which turns anything unresolved into a whole-book `page_rewrite` — and
that is what once quoted hundreds of credits to rewrite every page of a book in order to change a
heading that is synthesized at export time and stored in no page.

Add the recogniser stage-gated (`options.stage === "complete"`) unless it genuinely applies before
approval.

**Structural?** Insert, delete or reorder pages is `restructure_pages`, and it is the one kind
whose targets do not exist yet. It forks ahead of `affectedPagesForIntent` in both
`proposeBookEdit` and `queueChatBookEdit` — that resolver filters against pages the book *has*, so
an insert reaching it is answered "which page or exact phrase should I edit?" and never gets a
card. Its work lives in `apps/api/src/mobile/restructurePageOperations.ts` and
`structuralPageEdits.ts`, the shared resolver in `packages/core/src/generation/pageRestructure.ts`,
and the worker's fork in `apps/worker/src/handlers/restructurePages.ts`.

For a model-routed intent instead, edit `apps/api/src/bookEditRouterPrompt.ts`:
`decideActionSchema`'s `editTarget` enum, any new payload fields beside it, and the prompt line that
tells the model when to pick it. Then map the target to an intent in `intentFromProposeEdit`
(`bookEditIntent.ts`). A new `DecideAction` (not just a new target) also needs `decideActionsByStage`
and `intentFromDecideAction`.

Whatever you add to the model path, add a fallback: `classifyWithDegradedHeuristics` is what runs
when there is no text model or the router throws, and its catch-all is a `clarify`.

## Step 3 — the one-clarifying-question budget

One question per request, enforced in **three** places. Adding an intent means deciding what happens
to it when the budget is spent.

1. `decideActionsFor` (`bookEditRouterPrompt.ts`) drops `clarify` from the action enum the model may
   return once `clarifyExhausted` is set.
2. `normalizeIntentForStage` *skips* the `BOOK_EDIT_CONFIDENCE_THRESHOLD` demotion when
   `clarifyExhausted` — demoting would rebuild the loop the flag exists to break.
3. `forcedDecision` coerces any surviving `clarify` into `page_rewrite` (`all_pages` when no page is
   named), and widens a pageless `page_rewrite`/`local_patch` the same way so it cannot reach
   `proposeBookEdit`'s "which page?" question as a second question.

`clarifyExhausted` itself is computed in `apps/api/src/mobile/routes/projectChat.ts` from
`findPendingScopeClarification` (`apps/api/src/mobile/pendingEditState.ts`), which merges the stored
request with the follow-up via `messageWithFollowUp`.

So, for a new intent, answer: **when the budget is spent and the request is still ambiguous, what
should it become?** If a whole-book `page_rewrite` is the wrong answer for your intent — and for
anything free or structural it usually is — `forcedDecision` needs an arm for it. Also decide
whether it belongs in `PROPOSAL_GATED_EDIT_KINDS`: kinds in that set skip the confidence demotion on
a finished book, because their proposal card *is* the confirmation step and a demoted one replies
"I'll rewrite the final page…" with no Apply card and no question.

Note the deliberate tautology in `intentFromDecideAction`: every `clarify` records
`clarification: "scope"` even when the model reported `"none"`. That is what makes
`handleProjectChatIntent` store the resumable `pendingEdit`. Do not "fix" it.

## Step 4 — propose and apply

In `apps/api/src/mobile/bookEditIntents.ts`:

- `handleProjectChatIntent` — the branch table. Free presentation intents branch out early and are
  gated on `["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)`. Charged intents build a
  proposal: cost from `bookEditCreditCost`, text from `editProposalMessage`, card from
  `editProposalSummary`, metadata from `pendingEditMetadataFromState`.
- `proposeBookEdit` — resolves quoted targets and asks the one real "which page?" question.
- `applyOrCancelEditProposal` — the Apply path, which is where the charge and the job happen.

Chat replies never name a credit price in their text: the number travels as
`metadata.creditsCharged` or `metadata.editProposal.credits` and the app draws the badge.
`stripCreditAnnouncement` in `apps/api/src/mobile/projectChat.ts` removes the old sentence from
historical transcripts, so a new priced reply that writes the price into its prose says it twice.

If the request reaches a model, store character sheets as `characterContext` on the operation and
payload, never fused into `request`, `editInstruction`, `perPageInstructions`, or the `REVISE_PLAN`
`message`. `REVISE_PLAN` composes them for the planner via `authoritativeReplanMessage` the same way
`REPLAN_BOOK` does. `requestWithCharacterContext` remains only for the image insertion/layout payload
`request` string. The bare message is what `classifyProjectChatMessage`, `affectedPagesForIntent` and
`exactReplacementFromMessage` read, and a sheet inside it moves page targeting and the price.

## Step 5 — the recompile

Every `contentRevision` bump must queue its own compile, and **you must ask what the queue did**:

- Presentation edits: `applyPresentationPreference` writes the field, EDITING and the revision bump
  in one row write, then calls `queueUserEditExportRecompile` (`apps/api/src/mobile/manualEdits.ts`),
  which always enqueues.
- Worker-side edits: `applyBookEdit` calls `maybeEnqueueCompile` and **reads the
  `CompileDispatchOutcome`** — on `"not-ready"` it restores the settled status rather than trusting
  that something was queued. `maybeEnqueueCompile` refuses to queue while a compile for the current
  revision is QUEUED or ACTIVE, so a silent no-op leaves the project EDITING with its exports
  already deleted and no sweep able to reach it.

## Verify

```bash
pnpm --filter @book-maker/api test -- bookEdit projectChat pendingEdit editOperations
pnpm check
```

Then drive it end to end with `MOCK_AI=true pnpm dev:api` + `MOCK_AI=true pnpm dev:worker` against a
finished book, and check four things by hand:

1. The intent is recognised **without** a model (kill the text model or use the heuristic path) —
   a router outage must not turn your edit into a whole-book rewrite.
2. Asking ambiguously twice produces exactly one question, and the second turn acts.
3. A free edit writes no `CreditLedgerEntry` and no `BookEditOperation`, and leaves the project's
   `qualityReport` intact.
4. The book's exports come back: `contentRevision` incremented, a `COMPILE_EXPORT` row queued for
   that revision, and the project back to COMPLETE afterwards.
