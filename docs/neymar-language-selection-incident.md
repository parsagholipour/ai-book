# Neymar book language correction

The local creation chat on 2026-09-28 began with an English request for a ten-page Neymar/waitress romance. The assistant volunteered Portuguese and stored `language: pt`. After the user wrote `No in English`, the project-chat classifier correctly recorded `kind: plan_revision` and `targetLanguage: English`, but both saved plan versions remained Portuguese.

The creation assistant was allowed to invent a language while developing the story. The revision worker then read the old plan's input snapshot without applying the classifier's target language. English generation guidance was also omitted entirely, allowing an old foreign-language plan or assistant suggestion to influence subsequent output.

The fix resolves the book language separately from user-authored messages, before the creative conversation runs. A user's explicit language request takes priority; otherwise a new book follows the language they wrote in. Assistant messages, generated briefs, attachments, and character nationalities are excluded as evidence. Both `update_settings` and `finish_turn` reject a conflicting language so the model can correct its response within the existing bounded tool loop. The resolver adds one small, time-bounded fast-model call to a creation turn.

The revision worker consumes the language already stored in the edit operation's classifier, with a high-precision text fallback for direct revisions. The same resolved language reaches the planner and is saved transactionally in the new input snapshot and project. English now gets explicit generation/review guidance, and language revisions instruct the planner to translate every book-facing field instead of inheriting untranslated fields as unchanged.

Deterministic regressions reproduced both failures before the fix. Tests cover the initial erroneous Portuguese tool setting, a conflicting finish response, the exact correction, persistence for later generation, direct revisions, and preservation of a Portuguese book during an unrelated edit.

Live verification with the configured models passed the original request, English correction, Portuguese and Persian conversations, an explicit Portuguese request written in English, retention of a selected Portuguese language, and a language mentioned only as subject matter. Replaying the saved Portuguese plan with the correction produced `Between Noise and Silence`, an English premise, and five English chapter titles. Verification artifacts are in `.scratch/neymar-language-fix/`.

The verified English plan was installed locally as version 3, preserving both Portuguese versions. The project, new input snapshot, and creation draft now store `en`. This repair made no credit-ledger changes.

`pnpm check` passed typechecking, lint, size, gotcha, subpath and script-test gates. The full test run passed 9,564 tests and reported six export-cleanup timeouts; all eleven tests in that unchanged cleanup suite passed when run separately. The final focused language suites passed 77 tests, and all seven live language scenarios passed.
