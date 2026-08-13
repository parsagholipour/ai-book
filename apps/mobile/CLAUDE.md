# Mobile app

The Flutter app — this is the product. ~228 files under `lib/`, ~111 test files under `test/`.

```
lib/app/       app shell, routing, theme
lib/shared/    api client, auth token store, design system, feedback widgets
lib/features/  projects · reader · characters · billing · voice · audiobook · auth · account
```

Every feature is layered `data/` → `domain/` → `presentation/`. Riverpod providers live inside the
repository files in `data/`, not in a separate `providers.dart`.

`main.dart` must call `pdfrxFlutterInitialize()` before `runApp`.

## Checks

`pnpm check` does **not** cover Dart — `apps/mobile` is not a pnpm workspace and `.oxlintrc.json`
ignores it. If you touched anything here, run `pnpm check:mobile` (or `make mobile-analyze` and
`make mobile-test`) as well. The 900-line file-size budget *does* apply to `.dart`, via
`node scripts/check-file-sizes.mjs`.

The pdfrx natives are unavailable under `flutter test`, which is why `BookReaderScreen` takes its
viewer through `readerViewerBuilderProvider` — so tests can stub it.

## Feature-level invariants

- `lib/features/projects/CLAUDE.md` — the export-repair watch budget, credit quoting, the
  `part`-file creation chat.
- `lib/features/reader/CLAUDE.md` — the PDF reader, page location, and what the client may do with
  an export's provenance.
- `lib/features/audiobook/CLAUDE.md` — playback, the listening position, and what `playing` means.

## What the app mirrors from the server

These have no compiler tying them to their server-side twin, so they must be changed on both sides
at once:

- **The credit formula.** `estimateProjectCredits` in
  `lib/features/projects/domain/project_models.dart` re-implements `tierPrice` from
  `packages/core/src/billing.ts`, and there is no server quote route to fall back on. Both sides
  spell their totals out in tests rather than deriving them from the price table, deliberately.
- **The question pickers.** `answerKind` (`choice` / `multi` / `open`) is declared by the server and
  obeyed by four pickers; fewer than two options is `open` whatever the model said. A `multi`
  answer travels as one line.
- **Job progress steps** are *not* mirrored — the app renders whatever the server serializes, and
  greps for job-type names in `lib/` return nothing. Keep it that way.
- **Prices are not hardcoded** anywhere in the app; they arrive in the billing payload. Keep that
  too.

<!-- gotcha-index: pointer-only -->
