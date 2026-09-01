# Provider adapters

Every call to an outside model goes through here: Gemini, the OpenAI-compatible providers,
Alibaba, DeepSeek, DeepInfra, OpenRouter, plus routing (`textRouting.ts`, `modelTiers.ts`), fallback
(`textFallback.ts`, `imageFallback.ts`) and `retry.ts`.

`factory.ts` decides what a job gets. With `MOCK_AI=true` it returns the fakes in `fake.ts` —
canned text, images, speech, embeddings and research — which is how the whole pipeline runs with no
tokens and no network. With `MOCK_AI=false` and no key it throws rather than silently degrading.

The worker never constructs an adapter directly; it wraps a set with `createLoggedProviders`
(`apps/worker/src/providers/loggedAdapters.ts`) so every call is logged, costed and stop-checked.

## Errors and retries

`ProviderHttpError` **carries the HTTP status as a field**, not just in its message. A status that
only appears inside message text matches none of `isRecoverableNetworkError`'s patterns and would
never be retried — that is a real bug this shape exists to prevent. When a response names a
`retryDelay`, `withRecoverableNetworkRetry` waits it out instead of backing off blindly, but only up
to `PROVIDER_RETRY_AFTER_CEILING_MS`; a longer cooldown is a daily cap rather than a per-minute one,
so it is reported as unrecoverable and every layer gives up at once instead of spending its whole
budget failing the same way.

Stop-abort signalling is wired into every provider HTTP text adapter. OpenAI-wire adapters pass
the signal as the SDK's per-request option via `openAiRequestOptions`; Gemini passes it as
`abortSignal` in the request config. Every request path on those adapters must preserve it,
including streamed JSON and tool calls; adapters with no HTTP client ignore it.

- **A cancellation raised inside a tool escapes the tool loop; only a tool *failure* becomes a tool
  result.** `runToolLoop`'s whole point is that a tool blowing up is recoverable — the throw comes
  back as `{error: "The <tool> tool failed: …"}` and the model works around it. A stop is the one
  error that must not: answered that way it reads to the model as "that tool is unavailable", so
  the loop continues, the model finishes, and the caller writes and bills an answer for a run the
  reader already cancelled. `executeToolCall` (`toolLoop.ts`) therefore rethrows whatever the
  loop's `rethrowIf` claims, defaulting to `isCancellationError` (`retry.ts`). That predicate asks
  the error *who it is* — an `AbortError` or `StopRequestedError` `name`, an `ABORT_ERR` code, over
  the error and every nested `cause` — and not what it says, because the class it is really looking
  for, the worker's `StopRequestedError`, sits on the far side of
  `apps/* → packages/db → packages/core` and cannot be imported here; it holds the line the worker
  holds with `isStopRequestedError` in `prepareEmbedding`, `writePreparedEmbedding` and
  `degradeRetrievalArm`'s `rethrowIf`. **Identity, not prose**: the older `isStopOrAbortError`
  reads message text too, which is right where a false positive only *suppresses* something — a
  retry not taken or a speech fallback provider not tried, while the error still surfaces as the
  failure it is — and wrong here, where it would promote a recoverable failure to a fatal one. This
  one loop is shared by the worker's writer tools and by the API's two chat loops, so a provider or
  HTTP client whose message
  merely says "request aborted" would have ended a chat turn the model could have worked around.
  Narrowing costs the worker nothing: `LoggingEmbeddingAdapter.embed` runs `assertJobNotStopped` on
  its way out, so a cancellation reaching a tool is already a `StopRequestedError` when it is
  thrown, and everything downstream gates on `instanceof StopRequestedError`, narrower still. The
  rule belongs to the loop rather than to one tool because every tool inherits it: `search_memory`
  (`generation/writerTools.ts`) is only the first writer tool that reaches a provider at all —
  `lookup_page`, `lookup_entity` and `search_research` read what is already in memory or in the
  database — and the stop comes from the `assertJobNotStopped` inside
  `LoggingEmbeddingAdapter.embed`, which `searchStoredMemory` reaches through
  `retrieveSemanticPageMemory`. **The caller owes the same.**
  `generatePageDraftWithWriterTools` catches everything the loop throws, because a tool-loop fault
  must not fail a book — but a stop caught there falls back to the ordinary draft path and writes
  the page anyway, so it re-raises instead. The API's two loops (`mobileCreation.ts`,
  `bookEditIntent.ts`) have no stop signal to honour at all, and today nothing of theirs can trip
  the default either — `web_search` replaces whatever it caught with fixed model-facing prose,
  `read_page` swallows its load with `.catch(() => null)`, and the settings tools cannot throw. That
  is an accident of three handlers rather than a property of the surface, which is what
  `rethrowIf: null` is for: an explicit "nothing a tool throws ends this turn", worth passing at
  both call sites the next time either grows a tool that reaches the network directly.

  **`FallbackImageAdapter` is the same rule about the same word, and it was the one place still
  breaking it.** Its `catch (fallbackError)` wrapped *whatever* the second provider threw into an
  `ImageGenerationFallbackError` — `shouldFallback` (`!isStopRequestedError`) guards only the
  primary — so a reader who pressed Stop mid-fallback had the `StopRequestedError` that
  `LoggingImageAdapter.assertJobNotStopped` raises folded into a two-provider verdict. The wrapper is
  a stop to nobody: `isStopRequestedError` is an `instanceof` test by design, and
  `isImageContentRefusalError` is false too because the stop half is not a refusal. Every consumer of
  the class then read what was left. `CopyrightSafeRetryImageAdapter` matched neither guard and
  handed back the *original* two-provider refusal, for which `isImageContentRefusalError` **is**
  true, so `renderCharacterReferenceSheets` pushed it into `refused[]` and wrote it onto
  `PlanVersion.characterReferenceRefusals` — a cancelled run settling as a finished book whose
  character has no sheet for the life of the plan version, and no `markStopped`. `generateImage`'s
  handler would have stamped `imageFailureReason` on the page and `generateCover`'s would have
  swapped in a designed cover, on the same reading. The escape therefore lives in
  `failWithFallbackError`, where the wrapping happens, so one line fixes every consumer rather than
  one guard; the predicate is `isCancellationError` for the reason above, and `fallback.error` is
  still written to the run log first, because a stop is not a reason to lose the record that a
  fallback was reached at all.

- **A picture that never arrived is not a picture that was refused, and only the second is
  permanent.** `ImageContentRefusedError` is the one failure nothing retries: it skips
  `withRecoverableNetworkRetry`, `isRecoverableNetworkError` calls it unrecoverable, and
  `characterReferences.ts` writes it onto `PlanVersion.characterReferenceRefusals` as a settled
  fact that survives every retry of the book. So it may only be raised on evidence that a filter
  *answered*. Gemini's native image models intermittently hand back a perfectly normal turn with
  no bytes in it — a finish reason of `STOP`, sometimes `NO_IMAGE`, sometimes `IMAGE_OTHER`, with
  an apology, a cheerful "here you go", or nothing at all — and `missingNativeImageError` used to
  read a bare `STOP` as a refusal it called `NO_IMAGE`. That turned a blip into a character denied
  a reference sheet for the life of the plan, reachable only by replanning. `IMAGE_OTHER` was the
  same gamble one step quieter: the SDK glosses it "image generation stopped for a reason not
  otherwise specified", which is a broken render as readily as a filter, so it is no longer in
  `GEMINI_IMAGE_BLOCK_FINISH_REASONS`. What still makes those three a refusal is
  `isSpokenImageRefusal` (`imageRefusal.ts`) — a first-person decline, or the vocabulary a filter
  uses — read over the finish message, the block message and the prose the model returned in the
  picture's place. The named block reasons are unchanged and still answer first, because a filter
  that gave its own word needs no prose. Being wrong the other way costs a few retries and a
  fallback render; being wrong this way costs a book its cast.

  **And "spoken" is not "contains the word can't".** That predicate was a flat list of patterns
  any of which could settle it, so it read `"I can't wait to show you — here it is!"` and
  `"Error: unable to render image, connection reset by peer"` as refusals — the first being the
  cheerful no-bytes turn the paragraph above is *about*, the second a transport error echoed back
  as the text part. It now decides in four ordered readings, and the order is the argument.
  A **named outage** ends it before anything else is asked — a service reported temporary, timed
  out, rate limited, or a breakage bound to the thing it broke ("the model is overloaded", "the
  endpoint is offline", "connection reset"). A **filter naming itself** — a policy said to be
  *broken*, or intellectual property — comes next and is the strongest positive evidence there is;
  naming a policy is not objecting to one, which is why the bare `(content|safety|usage|image)
  polic` pattern is gone and `"generated in line with the content policy"` no longer refuses
  anything. A **failure wrapper** — `error`, `failed`, `failure` — then ends it, which is what
  makes the subjectless `unable to …` family safe to keep. Only then does **a decline the speaker
  owns** count, and only one anchored to the act it declines: the modal has to govern *drawing* or
  *creating*, through its own verb phrase ("be able to", "going to") and nothing else, because
  anything else is a different verb taking an infinitive. `complete`, `finish`, `access` and
  `reach` are deliberately not acts — "I'm unable to complete the request" is what an outage says.

  **The two vetoes are the halves of one thing said apart, and both read the fault rather than
  the scene.** A filter answering wraps itself in `Error:` as readily as an outage does, so a
  single fault veto had to sit either side of the vocabulary reading and could only be on one:
  put after it, `"InternalError: the data inspection service is temporarily unavailable, please
  retry."` and `"Timed out waiting for the content policy check to finish."` were settled refusals,
  because the vocabulary reading asks for a filter word and never for an objection to go with it.
  So the outage half moved above it and the wrapper half stayed below, and `"Error: content policy
  violation"` and `"data inspection failed"` still refuse. What each half may *contain* is the
  other rule: Gemini's native models restate the request back as prose, so bare `busy`, `network`,
  `capacity`, `internal` and `servers` were the veto reading the illustration — a busy market
  street, the Cartoon Network character, a stadium filled to capacity — and each one quietly
  untyped a real refusal, spending three `withRecoverableNetworkRetry` attempts and a fallback
  render and never reaching `CopyrightSafeRetryImageAdapter`, which is keyed on the typed verdict.
  Those words now count only bound to a breakage by a closed gap ("the model **is** overloaded"),
  the same shape `isNeverRewritableRefusal` binds a harm word to a person with. **The binding is
  also what stops reading 1 outranking the verdict it sits above.** `unavailable`, `unreachable`,
  `offline` and `unresponsive` were left unbound when the rest were bound, so `"The requested
  content is unavailable due to IP infringement."` and `"Image generation is offline: content
  policy violation."` ended at reading 1 and stayed retryable — a bare `Error` out of
  `missingImageError` for a settled verdict, bought again by three `withRecoverableNetworkRetry`
  attempts, a whole async Qwen render and the fallback provider, with
  `CopyrightSafeRetryImageAdapter` never reached. They are states a *thing* is reported in, and
  which thing decides the verdict: a service unavailable is an outage, content unavailable is a
  block already made. What they bind to is a wider subject list than `busy` and `capacity` bind
  to, and safely so, because no picture is of a platform being offline — and it leaves out
  `content`, `image`, `prompt`, `request`, `generation` and `result` on purpose. `outage` alone
  stays unbound: it is the breakage itself rather than a state something is in, so nothing else
  can be one, and bound it would have made "we're experiencing an outage" fall through to the
  decline beside it. The decline patterns take the mirror of that rule: two carry `I`, and the two
  that carry no subject at all may only *begin* a sentence or clause, because "The image cannot be
  rendered." is a passive report whose subject is the artifact — the intermittent failure verbatim
  — while "Unable to generate an image for this prompt." is the model writing a headless sentence
  about itself.

  The clearance veto is scoped rather than global and stays that way: prose *clearing* the content
  ("the design is original and does not infringe", "the picture avoids any inappropriate content",
  "copyright is not a concern") discounts only the vocabulary reading, so `"I will not create
  images that infringe copyright"` still refuses on its decline alone. It reads both directions
  now — it used to look backward only, from a negation to an intellectual-property word, so it
  caught the one phrasing pinned in the test and neither the subject-first spelling nor any
  clearance about something that is not IP. What it negates is the *presence* of the subject and
  never the *permission*: "is not permitted by our content policy" is a filter objecting in as
  many words, and reading it as a clearance would discount the vocabulary that settles it.
  **And never the *undertaking*, which is the third thing a negation can be.** A refusal states what
  it will not do in the same words a clearance uses about what a picture lacks, so `avoid\w*`, a bare
  `without` and a bare `not` before a presence verb each discounted the one sentence carrying the
  objection — by its own verb. `namesIntellectualProperty` reads this same list per sentence, so
  "I must avoid generating content that infringes on intellectual property", "I can't create this
  image without infringing copyright" and "I will not depict any copyrighted character" all answered
  `other`: `CopyrightSafeRetryImageAdapter` rethrew, and for a reference sheet
  `renderCharacterReferenceSheets` wrote the refusal onto `PlanVersion.characterReferenceRefusals`,
  permanent for the life of the plan version — the rewrite inert for the exact refusal it exists for.
  What tells the two apart is tense and stance rather than vocabulary. `avoid` counts only as
  `avoids` or `avoided`, because a finite verb reports on a picture that exists while the bare stem
  is what a prospective modal takes ("must avoid", "will avoid", "to avoid"); `without` counts over a
  thing and never over the offence (`infringing`, `violating`, `breaching`); and a presence verb
  counts only under `do`-support, the copula or the perfect, because a modal's negation is an
  undertaking where `does not` is a report. **Deleting the ambiguous entries was the other answer and
  it is the wrong one, because the two readers of this list are not one asymmetry**: here a missed
  clearance is a picture-less blip typed as a settled refusal, and there a missed objection is a
  rewrite never offered — so an entry that cannot be told apart is narrowed rather than removed, and
  both `avoid` clearances are pinned in `imageRefusal.test.ts` as turns that stay retryable. The
  quantifiers (`no`, `none`, `nothing`, `free of`, `devoid of`, `clear of`) keep their bare spelling
  on that same trade: a refusal reaches them only by wrapping a noun phrase in a permission
  predicate, a deontic copula or a negation of the clearance itself, none of which is a spoken
  decline, while each of them carries an archetypal clearance. None of
  this touches the provider-code path — `GEMINI_IMAGE_BLOCK_FINISH_REASONS`, DashScope's
  `DataInspectionFailed`, `ALIBABA_CONTENT_REFUSAL_PATTERNS` — which is consulted first and
  unchanged.

  **DashScope declines the same way, and its sync endpoint is a chat endpoint.** Qwen's
  multimodal generation call can answer a filtered prompt with an ordinary 200 whose content part
  holds a sentence where the image belongs — and it also spells `DataInspectionFailed` inside a
  200 on some deployments, and reports a filtered picture as a *succeeded* async task whose result
  row carries the code. All three land in `imageResultFromResponse`, which used to throw a bare
  `Error`: retryable to `withRecoverableNetworkRetry`, to the image fallback and to BullMQ, so a
  settled verdict was bought three times over and a book whose only image provider is Alibaba never
  reached the copyright rewrite path, which is keyed on the typed error. `missingImageError`
  (`alibaba.ts`) now applies Gemini's rule to that 200: the filter's own code, or prose that
  declines — `isSpokenImageRefusal`, with DashScope's own
  `ALIBABA_CONTENT_REFUSAL_PATTERNS` handed in as the provider half of its first reading — is an
  `ImageContentRefusedError`, and an empty or non-declining turn stays the retryable failure it is.
  A refusal raised there settles the async fallback too, because `shouldFallBackToAsyncQwen` tests
  the verdict by identity before it tests any status.

  **A provider's filter words join the shared reading; they never run beside it.** There are three
  picture-less paths — Gemini native, Gemini Imagen, DashScope's sync 200 — and they are not one
  function, because they are not one decision. Only two of them read prose at all: Imagen is not a
  chat endpoint, so it has no model prose to read and the *presence* of `raiFilteredReason` is the
  whole verdict, with the recorded word synthesized out of `safetyAttributes.categories` under a
  fixed `RAI_FILTERED` prefix. The code test then differs three ways for reasons the SDKs force:
  Gemini's native turn carries two enum fields and each takes its own allowlist
  (`GEMINI_IMAGE_BLOCK_REASONS`, `GEMINI_IMAGE_BLOCK_FINISH_REASONS`, both in
  `geminiNativeImageRefusal.ts`); DashScope's `code` is a general-purpose error field that
  also carries `InvalidParameter`, so it takes a regex; and a rejected word of either kind travels
  on as a *qualifier* rather than as the verdict. **`promptFeedback.blockReason` used to take no
  allowlist at all** — the argument being that the field exists only when a filter blocked, so any
  value of it is a verdict — and that argument does not survive its own enum. Two of
  `BlockedReason`'s members assert nothing: `BLOCKED_REASON_UNSPECIFIED` is the proto zero value,
  which is what an *unset* field deserializes to, so a backend that spells it out made an ordinary
  picture-less turn a permanent refusal named `BLOCKED_REASON_UNSPECIFIED` — the bare-`STOP` bug one
  field over; and `OTHER` is `IMAGE_OTHER` under a different name, glossed "for other reasons … it
  may be due to the prompt's language", which covers an unsupported script (this product publishes
  in nine of them) as readily as a filter. So the four that name an objection settle it — `SAFETY`,
  `IMAGE_SAFETY`, `BLOCKLIST`, `PROHIBITED_CONTENT` — and everything else falls to the model's own
  prose. Membership is the whole test on purpose: the enum has already grown past the six the API
  documents (`MODEL_ARMOR` and `JAILBREAK` are Vertex-only and unreachable from this API-key
  client), so a member nobody has weighed lands on the cheap side by itself, and
  `geminiNativeImageRefusal.test.ts` walks the SDK's own enum to keep it that way. Collapsing those
  into one function buys a boolean per provider and a decision nobody can read — so what is shared
  is what genuinely *is* one decision, and the rest stays three honest copies with this paragraph
  over them.

  What genuinely is one decision is the prose, and that one is `isSpokenImageRefusal`. It takes an
  optional `providerVocabulary` that joins **the vocabulary reading**, and
  `ALIBABA_CONTENT_REFUSAL_PATTERNS` is passed to it that way. It used to be ORed beside the
  predicate instead — `isAlibabaRefusalProse(detail) || isSpokenImageRefusal(detail)` — and that
  left half is that reading with both of its guards missing: no clearance veto, and no ordering
  against the other three readings. Its bare `/content policy/i` is the very pattern the general
  vocabulary dropped, so
  `"The image was generated in accordance with the content policy"` — a drawn picture narrating its
  own compliance, pinned in `imageRefusal.test.ts` as a turn that stays retryable — was a permanent
  refusal on Alibaba and a blip on Gemini, on the one endpoint here whose prose is the model
  talking. Handing the vocabulary in keeps the ordering that made it right: DashScope's words still
  outrank a failure wrapper, because that is what the vocabulary reading is — and they are
  outranked in turn by a named outage, because "the data inspection service is temporarily
  unavailable" is DashScope's filter being *broken* rather than DashScope's filter answering.
  The two *error-body* paths (the
  async `FAILED` task, a non-2xx response) ask for the narrower `error-body` reading, and must: their
  prose is DashScope describing its own refusal, never a model declining, so the failure wrapper and
  the spoken decline have nothing to weigh there — `error` and `failed` are what an error body is
  made of, and a first-person decline read out of one would make a bad model name permanent.
  **The outage veto is the one reading that does travel, and it was missing — first from the prose,
  and then, for a while, from the arm above it.** DashScope spells its
  inspector's name into its outages exactly as into its verdicts, so `"InternalError: the data
  inspection service is temporarily unavailable, please retry."` matched `/data[_ ]?inspection/i`
  and left both paths as an `ImageContentRefusedError` recorded under the reason `InternalError` —
  unretryable everywhere, and written onto `PlanVersion.characterReferenceRefusals` for a reference
  sheet — while the very same sentence through `isSpokenImageRefusal` had always answered `false`.
  Putting the veto in the *prose* predicate fixed the sentence and not the decision: all three paths
  read `isAlibabaRefusalCode(code) || <prose>`, and the code arm short-circuits, so the same outage
  reported under `DataInspectionFailed` rather than `InternalError` — which is what DashScope's own
  inspector calls its own failure — never reached the veto at all. **So there is one function,
  `alibabaRefusalReason` (`alibabaImageRefusal.ts`, beside its adapter the way the two Gemini
  refusal modules are), it asks `namesProviderOutage` first and above *both* arms, and the prose
  `reading` (`error-body` or `model-turn`) is the only thing a caller chooses.** A fourth path here
  inherits reading 1 whether or not it thought about it, which is the point; and the veto is
  imported from `imageRefusal.ts` rather than restated, because a caller owns its filter's
  vocabulary and no part of what outranks it. **And it answers with the label rather than with the
  arm that earned it, because a caller read the arm as a boolean and proved the two are not the
  same question.** It used to return a discriminated `{source: "code" | "prose"}` so the two callers
  could label the verdict as each arm requires — a code *is* the reason, a prose-settled refusal is
  recorded under `spokenImageRefusalReason` with the rejected code as its qualifier — and
  `missingImageError` honoured that while `alibabaContentRefusal` used it for its truthiness and
  wrote `code ?? "DataInspectionFailed"` over every verdict. So a 400 reading
  `{code: "InvalidParameter", message: "Input contains ip infringement"}` lost the code arm, won on
  prose, and was recorded under `InvalidParameter` — the very code the filter test had just refused;
  a 400 carrying only a refusing message was recorded under `DataInspectionFailed`, a code DashScope
  never sent. That label is what `imageRefusalReason` writes into the run log and onto
  `PlanVersion.characterReferenceRefusals`, so the durable record of why a character has no sheet
  named the wrong cause permanently, the set never being re-rendered; the async FAILED poll reached
  it the same way with `status: undefined`. With the arm folded in, the misuse is not expressible:
  what comes back is the reason string or `undefined`. The two error-body paths are the same
  statement twice and build the error once, in `alibabaContentRefusal` — the only status test, which
  the async path stands down by passing `undefined` rather than asserting a literal `400` no
  response ever sent, and a path with no turn behind it, so a prose verdict there is `NO_IMAGE`. The code
  it reads is one function too, `alibabaErrorCode`, and its last read is `output.results[0].code`:
  the async endpoint reports a filtered picture as a *result row*, on a task that says `FAILED` as
  readily as `SUCCEEDED`, and only the SUCCEEDED half used to read that row. The label a prose-settled refusal is recorded under
  is one function for the same reason, `spokenImageRefusalReason`: the finish reason when it says
  more than "the turn ended", `NO_IMAGE` when it does not, and the comparison is case-insensitive
  because Gemini screams `STOP` and DashScope whispers `stop`.

- **DashScope's async endpoint is text-to-image, so a request carrying references never goes
  there.** `AlibabaImageAdapter.generateImage` falls back from the sync multimodal call to
  `text2image/image-synthesis` on a 5xx or a 408, and that endpoint's body is `input: { prompt }` —
  there is nowhere to put a reference image, and every model `supportsAsyncQwenImage` routes to it
  (`qwen-image`, `qwen-image-plus`) is marked `supportsReferenceImages: false` in
  `alibabaModels.ts`. The fallback asked only whether the *model* was async-capable, so a
  reference-carrying request that reached it came back as a picture drawn from the prompt alone —
  no cast likeness, no library face seed, no event and no run-log line. That is the loss
  `refitForFallback` exists to make visible one entry down, at 100% instead of partial and with the
  visibility missing; and for a character reference sheet it is worse than a failed render, because
  the sheet is written as an ordinary `ImageAsset`, `characterReferenceSetIsSettled` then reports
  the cast settled, and that off-model sheet is what every page and the cover are drawn against for
  the life of the plan version. **Nothing could reach it, and that was the problem**: the guard was
  two hand-kept lists that happen not to overlap — `supportsQwenImageReferenceImages` names the
  `qwen-image-2.0` family, `supportsAsyncQwenImage` names two models outside it — with nothing tying
  them together and nothing that would fail if they did. DashScope enabling async synthesis for
  `qwen-image-2.0` is one word in a list this file keeps by hand. So the fork asks
  `asyncQwenImageCanServe(model, request)` rather than the model alone, and `generateAsyncImage`
  refuses a request it cannot serve outright, which is the rule the entry below states: *an adapter
  is never handed a request it has already declared it cannot serve.* Declining costs the render
  nothing — the sync `ProviderHttpError` travels on to `withRecoverableNetworkRetry`, whose next
  attempt re-runs the multimodal endpoint references and all, and to `FallbackImageAdapter`, whose
  other provider takes references too. Every one of those can draw the picture that was asked for;
  the async endpoint is the only path here that would draw a different one and call it the same.
  Trimming rather than declining, the way the fallback does, is deliberately *not* the answer for
  this one: there the choice is a smaller picture or a failed book, and here the smaller picture is
  a permanent, invisible lie about what a character looks like.

- **A fallback pair reports the primary's reference budget, and the fallback attempt re-fits the
  request to its own — the prompt included, because the prompt counts the pictures and names the
  last few.** `FallbackImageAdapter.capabilities()` is what every caller sizes a
  character-reference attachment against (`selectReferenceImagePaths`,
  `shouldUseCharacterReferenceImages`, the spare-budget face slots in `applyImageInsertion`), and
  the two adapters rarely agree. On the stock config a premium cover runs `gemini-3-pro-image`
  (five references) over a `qwen-image-2.0-pro` fallback (three); point `ALIBABA_IMAGE_MODEL` at
  `qwen-image-max`, `qwen-image-plus` or `qwen-image` — all offered in
  `alibabaImageModelOptions` — and the fallback takes none at all. **Reporting the intersection is
  the wrong conservative answer**: it would size every render against the adapter that almost never
  runs, permanently costing a premium cover two sheets and turning character consistency off for a
  whole book to pay for an outage that may not happen. So the promise stays the primary's, and
  `refitForFallback` keeps it honest — because the alternative is worse than either. `qwen-image-max`
  handed reference images throws a plain `Error` reading "cannot consume character reference
  images", and a plain error is definitively **not** a refusal: `isImageContentRefusalError` needs
  every attempt in the `ImageGenerationFallbackError` to be one, `CopyrightSafeRetryImageAdapter`
  rethrows, and `renderCharacterReferenceSheets` reads it as the outage it looks like, sets
  `failed` and fails the whole GENERATE_BOOK job — a healthy fallback that could have drawn the
  picture without references failing a book instead, which is the exact inverse of the rule the
  callers are built on. **An adapter is never handed a request it has already declared it cannot
  serve.** The cut is from the *tail*, which is the priority order `selectReferenceImagePaths`
  builds — sheets first, the reader's own library artwork appended into whatever budget the sheets
  left — so a squeezed render gives up a face before a character's design.

  **The prompt is not a bystander to that cut, because both of its claims about the attachment are
  indexed.** `characterReferencePromptInstruction` states a count — "use the 5 attached character
  reference images as the authoritative design source" — and `libraryCharacterFaceInstruction`
  adds a tail attribution: "the last 2 reference images are the reader's own saved artwork for Ada
  and Bea … match it exactly". Sending three under a prompt written for five does not drop two
  pictures, it hands the remaining three *different identities*: Bea's and Cid's sheets become
  Ada's and Bea's saved faces, to be matched exactly. A wrong face, drawn silently, on the one
  render path with no reference-image quality signal — worse than the failed book the refit exists
  to prevent, and a fallback trim is exactly where nobody is looking. So the coupling the type
  could not express is now a field: `ImageRequest.promptForReferenceImages` is the caller's way of
  saying its own prompt again for a shorter list, `refitForFallback` calls it with what it actually
  sends, and every attach site owns its sentences — the four that go through
  `characterReferencePromptInstruction`, the reference sheet's "the attached image is this
  character's existing, approved artwork", and the portrait's `fromPhoto`. Re-emitting the count
  from inside the refit was the other answer and it is the shallower one: it patches the sentence
  this release happens to send, from a package that may not import the module that writes it, and
  leaves the next caller free to bake in a claim nothing knows how to restate. A caller that leaves
  none gets **no partial attachment at all** — an unre-statable trim goes out with zero references,
  losing the sheets, which is the loss this file already tolerates for a zero-reference fallback,
  where a partial attachment under a stale prompt is a positive instruction to draw the wrong
  person. `CopyrightSafeRetryImageAdapter` is the one layer that deliberately drops the field: the
  rewritten prompt is the text model's words, so the caller's re-statement would replace the
  rewrite with the original and hand the protected name back to the filter.

  **Emptying the array is only half of that, and the half that was applied.** Zero sheets under a
  prompt still reading "use the 5 attached … the last 2 are the reader's own saved artwork for Ada
  and Bea; match it exactly" is not a picture drawn from the text alone — it is a picture drawn
  from text describing pictures the model never received, told to match a face it cannot see. Same
  defect as the partial attachment, one step further along, and reachable in production on exactly
  the path where nobody is looking: the copyright retry deletes the field, so any primary failure
  on that second render arrives at the refit with no restater. It cannot carry one either, since a
  restater for the *rewritten* prompt would take another model call to produce — so the answer is
  at this end, and it is not the shallow one. Re-*stating* a claim needs the caller's words;
  **retracting one does not**, because with the attachment empty there is a single true statement
  about it, it is the same statement whatever the caller wrote, and it discharges every indexed
  claim at once. `NO_REFERENCE_IMAGES_CORRECTION` is appended to the prompt of every unre-statable
  trim — including one whose prompt happens to claim nothing, since which sentences a caller wrote
  is the one thing this layer cannot read — and it covers the zero case and only the zero case: the
  moment a single picture is attached, a blanket retraction stops being true and the trim has to be
  re-stated or emptied.

  And it is written down: `fallback.references_trimmed` reaches the run log as
  `image.generate.fallback.references_trimmed` with the requested, sent and dropped counts beside
  the fallback's limit and whether the prompt could be `restated` — which is what tells a zero
  `sent` under a non-zero `limit` from a fallback that takes none — because a page drawn without
  the sheets that hold a character still is a real quality loss, only a smaller one than a failed
  book, and silently is the one way it must not happen.

  **And the same record rides the picture, because a run log is not something a caller can read.**
  The trim is returned beside the refitted request and lands on
  `ImageFallbackMetadata.references`; absent means the fallback attempt got what was asked for.
  `CopyrightSafeRetryImageAdapter` is the caller that needs it: it has to say in a *durable* record
  how many likeness inputs its render read and nothing re-read, and it is also the caller whose
  deleted `promptForReferenceImages` makes an unre-statable trim reachable at all — so counting its
  own request wrote `unverifiedReferenceImages: 5` over a picture drawn from the rewritten text
  alone, and dropped the `replaced` list in the one case that had earned it. `fallback` on its own
  says which provider drew the picture and nothing about what it was handed.

- **A diagnostic write may not decide the render it describes.** `FallbackImageAdapter`'s four
  `onEvent` emissions are run-log appends — `image.generate.fallback.*`, a file write under
  `BOOK_STORAGE_DIR` — and each was awaited bare, in a position that settled the render. Three sit
  *outside* the try around `fallbackAdapter.generateImage`, so a rejection travelled out of
  `generateImage` as an ordinary `Error`: not an `ImageGenerationFallbackError`, therefore not an
  `isImageContentRefusalError` to anyone downstream, so `renderCharacterReferenceSheets` read a
  failed log line as an outage, set `failed` and failed the whole GENERATE_BOOK job — where a
  refusal would have been recorded and the book would have finished without that one sheet. The
  fourth was worse for being *inside* it: a throw from `fallback.success` was caught as the fallback
  provider's own error, so a picture already drawn was discarded and reported as both providers
  failing. `note` wraps all four, so the loss is a run-log line rather than a book, and it lives on
  the adapter rather than at the four call sites for the reason `recordTruncatedRepairPass`
  (`apps/worker/src/handlers/compileExportFence.ts`) states one file over: a call whose whole job is
  to leave a trace should not be able to fail the thing it traces, whoever writes the next one.
  `RunLogger.append` swallowing its own write failures is not that guarantee — this adapter takes an
  arbitrary caller's callback, and the worker's builds a path, reads config and serializes an error
  before it ever reaches that swallow. A cancellation still travels, by `isCancellationError` and
  for the reason `bestEffortPass` rethrows one: a reader who ended the run must not have it continue
  into a second render.

- **An Imagen score table says what the classifier scored, never what the filter blocked on, so it
  is diagnostics and the sentence is the verdict.** `generateImagenImage` asks for
  `includeRaiReason` *and* `includeSafetyAttributes` (`geminiImagenRefusal.ts` reads the answer). It
  asked for only the first for a long time, so `safetyAttributes.categories` was never sent and
  every block was recorded as the bare word `RAI_FILTERED`. Turning the flag on and folding the
  categories into `reason` was worse: `categories` is the provider's *standing* RAI list ("Death,
  Harm & Tragedy", `Porn`, "Violence", "Toxic", …) with `scores` beside it, so every answer names
  them all, `NEVER_REWRITABLE_CODE` is a bare word test over exactly that field, and every Imagen
  copyright block vetoed itself — silently, since the gate rethrows before any run-log line.
  **Score-gating the fold did not save it, and no threshold can.** A probe of a copyright-blocked
  prompt scored `[0, 0.1, 0.8]` across `["Death, Harm & Tragedy", "Porn", "Violence"]`: the request
  blocked *for copyright* carried 0.1 on `Porn` — enough for any `> 0` gate — and 0.8 on a category
  that belonged to no part of the block, which is a counterexample at the top of the range. Nothing
  in the table separates "the classifier saw something" from "the filter blocked on this", because
  the table is not about the block and `safetyFilterLevel`'s cut is never reported. So the whole
  table goes to `ImageContentRefusedError.diagnostics` — a third field beside `reason` and `detail`
  that `refusalEvidence` does not read and the constructor keeps out of `message`, carried to run
  logs by being an own enumerable property. `RAI_FILTERED` is not the whole verdict either: the
  categories reach `reason` by one route, `imagenNamedCategories`, which keeps a category the RAI
  sentence **itself names** — the filter having written the word into its own statement about this
  request, which is what makes a word test over it safe. The table contributes vocabulary, the
  sentence contributes the assertion. That also closes the prose half's one gap here, since
  `NEVER_REWRITABLE_VOCABULARY` spells the harm word `pornograph\w*` and a sentence naming the
  category `Porn` would otherwise slip past it. **The degenerate `scores` shapes decide nothing
  now** — omitted, shorter than `categories`, string-typed, `NaN` — where each used to fall
  *toward* the veto and cost a picture; an unreadable reading is written down as `?`. That old
  rationale ("unscored is not scored zero") also had the asymmetry backwards from the one
  `isNeverRewritableRefusal` is written under: being wrong toward the veto costs a picture nobody
  may ask for again, being wrong away from it costs one rewritten prompt a child-safety filter
  refuses identically, since a rewrite may only remove protected *names*. Two reads went the other
  way and are gone: `GenerateImagesResponse` carries `generatedImages`,
  `positivePromptSafetyAttributes` and `sdkHttpResponse` and nothing else — the SDK's
  `generateImages` rebuilds its answer out of exactly those three — so a top-level
  `response.raiFilteredReason` is a field no Imagen call can produce, and reading one could only
  settle a picture that never arrived as permanently refused. With it gone, an answer where no
  entry names a filter names no filter at all, which is why the filtered-entry lookup no longer
  falls back to `images[0]`. On a blocked request the picture has no scores to report — a filtered
  prediction carries a reason and nothing else — so the prompt's attributes, labelled `PROMPT`, are
  usually the only vocabulary there is.

  **That second opt-in also arms the SDK's one discard, and what keeps it harmless is the endpoint
  rather than the SDK.** `models.generateImages` walks the predictions and, for any entry whose
  `safetyAttributes.contentType` is `"Positive Prompt"`, lifts the attributes to top-level
  `positivePromptSafetyAttributes` and **drops the entry** — its `raiFilteredReason` with it, past
  recovery: the rebuilt answer is those three fields, `SafetyAttributes` maps only `categories`,
  `scores` and `contentType`, and `sdkHttpResponse` carries headers with no body. A reason riding a
  stamped entry would leave `generatedImages` empty, `missingImagenImageError` with nothing that
  names a filter, and every Imagen block back to the retryable `Error` that `includeRaiReason`
  exists to replace — the original bug returning through its own fix, silently. It cannot ride one,
  and the reason is a property of Imagen: the prompt's table is its *own* prediction, and if an
  output image is filtered its safety attributes are not returned at all, so the entry carrying the
  reason has no `safetyAttributes` and therefore no `contentType` to be stamped with. That is a
  two-sided fact and both sides are pinned through the real client over a stubbed transport in
  `geminiImagenRefusal.test.ts` — a stubbed `ai.models` forwards whatever it is handed and would see
  none of it, so only a test that drives the SDK notices a bump moving the line.

  **And the gap between a filter verb and the category it governs owns its whitespace once.**
  `VERDICT_GAP`'s punctuation arm was `\s*[:=,-]\s*` inside a `*`, so the run of spaces before a
  separator could be claimed by the previous repetition's tail, the next one's head, or split
  between them — three parses per separator, all tried before the match failed. `"blocked" + " - "
  .repeat(n) + "ZZZ"` measured 1 ms at n=10, 89 ms at 14, 813 ms at 16 and 7.2 s at 18 for a single
  category, and `imagenNamedCategories` runs one such regex **per entry** in the standing table —
  which is exactly what `includeSafetyAttributes` makes twelve entries long. `raiFilteredReason` is
  provider text, the loop is synchronous, and the thread it holds is the worker's only one inside a
  generate-image job: long enough for BullMQ to call the job stalled and redeliver it. The gap now
  takes one leading whitespace run and one after each token, so no two runs are adjacent and nothing
  has a second parse, and the repetition is bounded on top — a ceiling is what stops a future arm
  buying the exponent back. The language is unchanged. `HARM_OBJECT_GAP`, `HARM_SUBJECT_GAP`,
  `DECLINE_TAIL` and `FAULT_LINK` were measured for the same shape and are flat: every one of them
  anchors each repetition to a required non-space word, which is the property that was missing here.

- **A native safety rating asserts only where it says `blocked`, and that flag is the one structured
  door the child-safety veto has.** Everything `missingNativeImageError` read used to be a
  `finishReason`, a `blockReason`, a message or the model's own sentence — and on this path `reason`
  can only ever hold an allowlisted block or finish reason (`SAFETY`, `IMAGE_SAFETY`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `NO_IMAGE`, `STOP`, …), **none of which matches**
  `NEVER_REWRITABLE_CODE`. So the never-rewritable veto had no structured door at all on Gemini
  native and was decided entirely by English regexes over a sentence the model wrote: a block whose
  ratings said sexually-explicit-and-blocked, answered in bland prose that also named a franchise,
  came out `"copyright"` and bought a paid text rewrite plus a second full primary→fallback render.
  `candidate.safetyRatings` and `promptFeedback.safetyRatings` were never read, though the SDK maps
  both on the API-key path (`candidateFromMldev`) and neither needs a request flag — there is no
  `includeSafetyAttributes` equivalent in `GenerateContentConfig`, only `safetySettings`, which sets
  thresholds rather than reporting. **This is Imagen's table in every respect but the one that
  matters.** It is a standing table by the SDK's own words — "There is at most one rating per
  category" on the candidate, "There is one rating per category" on the prompt — so a row is the
  classifier having scored a category on an answer it drew as readily as on one it refused, and
  folding those names into `reason` is the Imagen bug verbatim, one provider over. What Imagen has
  no counterpart for is `SafetyRating.blocked`: "Indicates whether the content was blocked **because
  of this rating**" — the filter's own per-row statement about *this* request, which is precisely
  what the standing table could never make and what the RAI sentence's grammar had to be mined for
  instead. So `nativeSafetyRatings` keeps the rows saying `blocked` and appends their categories to
  `reason`, where they are enum constants rather than prose and a bare word test over them is safe;
  every other row goes to `diagnostics`, which nothing reads. Three details carry the asymmetry. The
  test is `=== true`, not truthiness, because a string `"false"` is truthy and an unreadable answer
  has to fall toward the retryable side. A blocked row whose category will not read asserts nothing,
  having no word to assert with. And **a rating refines a verdict; it never establishes one** — the
  ratings are read inside the `if (refusal)`, so a `blocked` row on an otherwise ordinary
  picture-less turn stays the retryable failure it is, and no new path can make a blip permanent.
  Only two `HarmCategory` members carry the veto, `HARM_CATEGORY_SEXUALLY_EXPLICIT` and its `IMAGE_`
  twin, because those *are* the never-rewritable categories; Gemini publishes no
  `HARM_CATEGORY_CHILD_SAFETY`, and if it ever does that spelling vetoes on arrival, which is the one
  direction this may grow by itself. `geminiNativeImageRefusal.test.ts` walks the SDK's enum for both
  halves, the way it already walks `BlockedReason` — but the categories travel **raw**, because the
  enum is a bump alarm and not a ceiling: `HARM_CATEGORY_SEXUAL` is documented on
  `generativelanguage` as one of six PaLM-era members and is absent from the SDK enum outright, so a
  list built from `HarmCategory` could not have named it while a bare word test vetoes it on the same
  word. **Two facts bound how often the door fires, and neither is fixable in this module.** Google
  documents the default safety threshold as `OFF` for 2.5- and 3-era models and glosses `OFF` as "no
  automated response blocking and no metadata is returned", so on the stock configuration the table
  may not arrive at all — and buying it by raising a threshold would start blocking books that render
  today, which is a product decision rather than a classification one. And the filter that actually
  catches child content is *non-configurable*, so it rates nothing: Google maps it to
  `PROHIBITED_CONTENT` ("usually CSAM") on both the prompt and the response side, and that label
  already settles a refusal without vetoing, because it is equally what Gemini says about a character
  likeness. So this is the structured *half* of the child-safety decision; the prose half in
  `imageRefusalVerdict.ts` is still load bearing, and a rating never establishes a refusal that the
  fields above it did not.

## Tests

Colocated, and they stub `process.env` rather than reading a `.env` — nothing here needs a real key
to run.

## Research and citations

- **A cited source is stored as the publisher's own address, never Google's.** Search grounding
  hands back every citation as a `vertexaisearch.cloud.google.com/grounding-api-redirect/...`
  wrapper: it names Google as the source in the chat, and it expires — fatal for a Sources list
  recompiled from `ResearchSource` rows forever. `GeminiResearchAdapter.search` unwraps at ingest
  (`packages/core/src/adapters/groundingRedirect.ts`), which is the only moment the wrapper is sure
  to still resolve, and `researchCitationsForExport` retries at compile time for rows written before
  that, writing the fix back. An unresolved wrapper is kept rather than dropped — a worse link still
  beats a missing citation — and the app's `displayHost` names no publisher for one. That retry
  lives in `packages/db` because **two** processes compile a book: the API renders inline when a
  compiled file is missing, and its own copy of the citation map skipped the unwrap entirely, so
  the same book's Sources list named Google or the publisher depending on which side rendered it.

## Speech, retries and quotas

- **Narration fails in three provider-shaped ways, and all three guards are load-bearing.** One bad
  chunk used to lose the whole audiobook. (1) The TTS model answers a bare `400 INVALID_ARGUMENT`
  for a handful of ordinary passages *only* when the style prompt is prefixed to them — either half
  alone is accepted, and it reproduces exactly — so `GeminiSpeechAdapter.synthesize` reads a refused
  chunk again without the direction and flags `stylePromptDropped`. (2) A per-minute speech quota
  makes 429 the normal case rather than an outage, so `ProviderHttpError` carries the status as a
  *field* — a status that appears only inside the message text matches none of
  `isRecoverableNetworkError`'s patterns and would never be retried — along with the `retryDelay` the
  response names, which `withRecoverableNetworkRetry` waits out instead of backing off blindly —
  but only up to `PROVIDER_RETRY_AFTER_CEILING_MS`. A cooldown longer than that is the *daily* cap,
  not the per-minute one, so `isRecoverableNetworkError` calls it unrecoverable and every layer
  gives up at once rather than spending its whole budget failing the same way.
