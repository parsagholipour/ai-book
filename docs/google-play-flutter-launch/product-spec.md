# Product Spec - Phase 01

## One-Sentence App Explanation

`Tomeza: AI Book Maker` is a guided mobile app that helps creators turn a prompt into a practical ebook, workbook, or short story, then pay or spend credits to export a polished PDF or EPUB.

## Product Thesis

The first Android release should not position itself as a generic AI writer. It sells a finished book-shaped outcome for people who already know why they need a book: lead generation, teaching, coaching, audience building, or a small creative product.

The first business target is stable USD 1,000/month. That means the product should favor a narrow paid workflow, clear export limits, and controlled generation costs over broad creative controls. The normal mobile user should choose a book goal and answer guided questions; provider, model, temperature, queue, and raw token controls stay hidden behind backend-owned product presets.

The Flutter app belongs in `apps/mobile` and should act as the mobile client for the existing TypeScript backend. The backend remains responsible for generation, exports, cost tracking, ownership, billing checks, credits, safety, and asset access.

## Repo-Aligned Starting Point

Repo inspection shows the current service is a local single-user AI book generation system with:

- Fastify API routes for projects, templates, planning, plan revision, job status, book preview, and Markdown/PDF/EPUB exports.
- A BullMQ worker that runs planning, page generation, image generation, cover generation, final review, and export compilation.
- Prisma models for projects, templates, plan versions, pages, chapters, image assets, jobs, provider call logs, and generated voice features.
- Core TypeScript template/category support for business, education, story, self-help, kids, science, health, biography, history, society, arts, and custom books.
- Existing technical UI controls in the web console that should be simplified into buyer-facing mobile presets.

Phase 01 does not require code changes. Later phases need to add real multi-user auth, project ownership, billing verification, credit enforcement, and mobile-safe API boundaries before launch.

## First Target User

The first persona is an independent creator, coach, teacher, consultant, or small business owner who needs a useful downloadable book but does not have time to outline, write, format, illustrate, and export it manually.

Their job to be done is: "Help me turn my expertise or offer into a credible lead magnet, workbook, or short guide I can share with my audience this week."

They would pay because the result saves production time, gives them a complete PDF/EPUB instead of loose chat text, and helps them create something that supports sales, teaching, or audience growth. They are not paying for abstract AI access; they are paying to leave the first session with a clear plan, a convincing preview, and a paid path to a usable export.

The expected first-session result is an approved outline plus a short preview that proves the app understood the audience, tone, structure, and book goal. Full export is the paid moment.

## First Use Case

The primary launch use case is a lead magnet or practical guide for a creator's audience. Example: a fitness coach makes a "7-Day Beginner Strength Guide", a language teacher makes a "Conversation Practice Workbook", or a consultant makes a "Small Business Pricing Checklist".

This should drive the mobile UX:

- Ask for audience, goal, topic, and desired outcome.
- Offer practical templates before creative ones.
- Keep page counts modest by default.
- Prefer checklist, exercise, framework, and example-rich outputs.
- Make the first paid export feel like a deliverable the user can send, sell, or use immediately.

## MVP Templates

| Template | First Buyer Value | Backend Alignment | Launch Limits |
| --- | --- | --- | --- |
| Lead Magnet Ebook | A focused PDF/EPUB that helps a creator collect emails, support an offer, or explain a niche idea. | `BUSINESS`, `SELF_HELP`, or `EDUCATION` category using practical guide style rules. | 12-24 pages, cover included, up to 4 interior illustrations or diagrams. |
| Workbook or Study Guide | A teaching asset with lessons, exercises, checklists, and recap sections. | `EDUCATION` category, especially workbook, study guide, how-to guide, language learning, or career skills subcategories. | 16-40 pages, cover included, up to 6 diagrams or instructional images. |
| Short Story | A compact creative book for testing the storytelling workflow without making fiction the whole business. | `STORY` category using fiction/story continuity support. | 8-24 pages, cover included, up to 4 scene illustrations. |

Secondary fiction can help with consumer appeal, but the first $1,000/month plan should prioritize the creator/workbook/lead-magnet buyer because their willingness to pay is tied to a business or teaching outcome.

Child-directed picture books are deferred even though the backend has a kids template. That market needs a dedicated safety, policy, age-gating, image consistency, and store review pass before public positioning.

## Minimum MVP Journey

1. Start from a prompt and a template preset.
   The user picks Lead Magnet Ebook, Workbook or Study Guide, or Short Story, then enters topic, audience, goal, tone, and any must-include details.

2. Generate an outline/plan.
   The backend creates a title, premise, audience, chapters, page targets, visual direction, and follow-up questions. This can be free because it sells the quality of the result without exposing the full cost of a complete export.

3. Revise the plan.
   The mobile app lets the user answer guided questions, accept suggested changes, and send a short revision request. The user should feel like they are shaping a book, not operating a model console.

4. Generate a limited preview.
   The backend generates a small preview, such as the introduction plus one representative section or story scene, with a cover concept when cost allows. The preview proves quality but does not provide the complete export for free.

5. Pay or spend credits for the full export.
   The paid action unlocks full generation under the selected preset limits and produces PDF and EPUB exports. Any larger page count, extra illustrations, or additional full regenerations consumes more credits.

6. Monitor, download, and share.
   Flutter handles progress display, local state, download, share sheet, and error recovery UX. Backend jobs, entitlement checks, asset access, and export compilation stay server-side.

## Pricing Hypothesis

The first monetization model is credit-based, with no unlimited usage. A "standard export credit" should map to a bounded generation package: one MVP template export under launch limits, one cover, a capped number of interior images/diagrams, final review, PDF, EPUB, and Markdown when offered.

Launch pricing hypothesis:

- Free: account creation, saved draft, outline/plan generation, guided plan revision, and limited preview. No full PDF/EPUB export.
- One-book export purchase: USD 9.99 for one standard export credit.
- Monthly creator plan: USD 19.99/month for 3 standard export credits, higher saved-project limits, and more preview/revision allowance. Credits are limited and should not imply unlimited AI usage.
- Credit packs: USD 7.99 for one extra standard export credit or USD 14.99 for two extra standard export credits, mainly for subscribers who need more than their monthly allowance.

Rough path to USD 1,000/month gross:

- Subscription-heavy path: 50 creator plan subscribers at USD 19.99/month = USD 999.50/month.
- Mixed launch path: 35 creator plan subscribers at USD 19.99/month = USD 699.65, plus 20 one-book purchases at USD 9.99 = USD 199.80, plus 15 one-credit packs at USD 7.99 = USD 119.85, for USD 1,019.30/month.

Gross revenue is not enough by itself. Later billing and entitlement phases should measure Google Play fees, payment taxes where applicable, text generation, image generation, storage, and export costs. Preset limits must be tuned so a standard export credit remains profitable after platform and AI provider costs.

## Product Guardrails

- Sell practical book outcomes, not generic AI writing.
- Default to modest page counts and selective images.
- Use named presets instead of raw provider/model controls.
- Make export the main paid conversion moment.
- Keep cost, billing, safety, ownership, and asset enforcement on the backend.
- Avoid child-directed public launch wording until a dedicated safety and policy review is complete.
- Avoid public-facing wording that implies bypassing moderation or weakening safety.

## Non-Goals For First Android Release

- No full marketplace.
- No author community.
- No unlimited plan.
- No complex desktop editor.
- No standalone Dart generation engine.
- No second backend.
- No broad "write anything" AI assistant positioning.
- No public child-directed picture-book positioning.
- No voice-character or live voice features in the launch MVP.
- No advanced provider, model, temperature, queue, or internal generation controls in the normal mobile UX.

## Phase 02 Handoff

Phase 02 should prepare `apps/mobile` and the monorepo architecture around this narrow product direction. The first Flutter shell should assume three buyer-facing templates, a prompt-to-plan workflow, plan revision, limited preview, paid export, progress tracking, and download/share. It should not scaffold a broad creative studio, marketplace, community, or model-control console.
