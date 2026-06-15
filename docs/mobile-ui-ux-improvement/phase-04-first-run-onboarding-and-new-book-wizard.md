# Phase 04 - First-Run Onboarding And New-Book Wizard

## Objective

Help a new user start a useful book without staring at a blank prompt or wondering which choices matter.

The wizard should feel like a guided creative brief, not a form copied from backend fields.

## UX Direction

- Lead with the outcome the user wants.
- Give examples before asking for open-ended input.
- Ask for enough information to produce a good plan, but keep optional details optional.
- Make length, visuals, quality, and cost implications understandable before project creation.
- Preserve user input when they go back or briefly leave the wizard.

## Implementation Tasks

1. Improve first-run entry:
   - Show what a first session creates.
   - Explain that the first plan is a draft the user can revise.
   - Do not over-explain AI or billing before the user starts.
2. Improve book type selection:
   - Describe each template by finished artifact and best use.
   - Show examples for lead magnets, workbooks, and short stories.
   - Keep child-directed positioning out of public launch UX.
3. Improve prompt collection:
   - Add helper prompts or chips for audience, goal, tone, and must-include details.
   - Provide examples that match creators, teachers, coaches, and consultants.
   - Avoid requiring a title before the app has enough context.
4. Improve length, quality, and visuals:
   - Explain page counts as expected ranges or output size.
   - Explain `Quick draft`, `Balanced`, and `Extra polish` in user outcomes.
   - Explain visuals as cover plus selected supporting visuals, not unlimited images.
   - Show likely credit impact if data is available.
5. Add review before create:
   - Summarize choices in plain language.
   - Make `Create project` consequences clear.
   - Let users go back without losing input.

## Acceptance Criteria

- A first-time user can choose a book type without needing domain knowledge.
- The prompt step helps users describe audience, goal, tone, and desired outcome.
- Length, quality, and visuals are understandable without exposing model settings.
- The final wizard step summarizes what will be created.
- The wizard validates kindly and preserves user-entered content during back navigation.
- The primary CTA always matches the current step.

## Tests And Validation

- Widget tests for wizard validation.
- Widget tests for back/forward state preservation.
- Widget tests for final review summary if added.
- Run `flutter analyze`.
- Run `flutter test`.
- Manual walkthrough with a realistic lead magnet, workbook, and short story prompt.

## Handoff Notes For Next Phase

Phase 05 should make the generated plan review as clear as the improved creation flow, especially around questions, revisions, and approval.
