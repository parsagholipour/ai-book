import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_editor_sheet.dart';

import 'character_test_support.dart';

/// The sheet's own `_descriptionMax`, which mirrors
/// `LIBRARY_CHARACTER_DESCRIPTION_MAX` in
/// `apps/api/src/mobile/characterSchemas.ts`.
const _descriptionMax = 2000;

/// The editor sheet is the form and nothing else: a name, a description, some
/// details, and the one description the server read off a picture — which is
/// offered and never applied. Everything about the pictures themselves moved to
/// the character's own page; those assertions live in
/// `character_profile_test.dart`, and everything about `@name` links lives in
/// `character_editor_mentions_test.dart` — except where the description's cap
/// is what decides what happens to them.
void main() {
  testWidgets('offers the suggestion without touching the description', (
    tester,
  ) async {
    await pumpCharacterEditorSheet(
      tester,
      testCharacter(suggestedDescription: 'A girl in a yellow raincoat.'),
    );

    expect(find.text('Suggested from your photo'), findsOneWidget);
    expect(find.text('A girl in a yellow raincoat.'), findsOneWidget);
    // The field still holds what the reader wrote — the offer changed nothing.
    final field = tester.widget<TextField>(
      find.widgetWithText(TextField, 'Brave, curious, always muddy.'),
    );
    expect(field.controller!.text, 'Brave, curious, always muddy.');
  });

  testWidgets('Use this fills the field locally, sending nothing', (
    tester,
  ) async {
    final repository = await pumpCharacterEditorSheet(
      tester,
      testCharacter(suggestedDescription: 'A girl in a yellow raincoat.'),
    );

    await tester.ensureVisible(find.text('Use this'));
    await tester.tap(find.text('Use this'));
    await tester.pumpAndSettle();

    expect(
      find.widgetWithText(TextField, 'A girl in a yellow raincoat.'),
      findsOneWidget,
    );
    // Accepting is a typing gesture, not a save: the reader can still edit it,
    // and Save carries it like anything else they wrote.
    expect(repository.updates, isEmpty);
    expect(find.text('Suggested from your photo'), findsNothing);
  });

  testWidgets('Dismiss retires the suggestion server-side', (tester) async {
    final repository = await pumpCharacterEditorSheet(
      tester,
      testCharacter(suggestedDescription: 'A girl in a yellow raincoat.'),
    );

    await tester.ensureVisible(find.text('Dismiss'));
    await tester.tap(find.text('Dismiss'));
    await tester.pumpAndSettle();

    expect(repository.updates, [
      {'id': 'char-1', 'dismissSuggestion': true},
    ]);
    expect(find.text('Suggested from your photo'), findsNothing);
    expect(
      find.widgetWithText(TextField, 'Brave, curious, always muddy.'),
      findsOneWidget,
    );
  });

  testWidgets('no card when there is nothing on offer', (tester) async {
    await pumpCharacterEditorSheet(tester, testCharacter());
    expect(find.text('Suggested from your photo'), findsNothing);
  });

  testWidgets('the form holds no pictures at all', (tester) async {
    // Everything about a picture moved to the character's page. A sheet that
    // still drew a face here would be the waypoint this split removed.
    await pumpCharacterEditorSheet(
      tester,
      testCharacter(photoKind: CharacterPhotoKind.photograph),
    );

    expect(find.byKey(const ValueKey('character-photo-target')), findsNothing);
    expect(find.textContaining('illustrated version'), findsNothing);
    expect(find.text('Save changes'), findsOneWidget);
  });

  testWidgets('editing an existing character answers with it', (tester) async {
    // The caller uses the answer to decide whether to open the page, so a save
    // that returns nothing would strand a newly created character.
    final saved = testCharacter();
    final repository = FakeCharactersRepository(saved);
    LibraryCharacter? returned;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [charactersRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  returned = await showCharacterEditorSheet(
                    context,
                    character: saved,
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextField, 'Mina Park'),
      'Mina Parker',
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['name'], 'Mina Parker');
    expect(returned?.id, 'char-1');
  });

  /// The description's cap, at the boundary. The rename that overruns it is
  /// asserted in `character_editor_mentions_test.dart`; what these are about is
  /// which string the refusal measures — the body carries the trimmed
  /// description, so whitespace on the ends is length the route never sees —
  /// and that a length past the cap costs the reader nothing but a refusal:
  /// the text stays whole, the sheet stops resolving links in it, and the only
  /// bound that ever clips is the ceiling twenty times further up.
  group('the description cap', () {
    const field = ValueKey('character-description-field');
    const save = ValueKey('character-editor-save');

    /// The description the sheet is holding right now.
    String descriptionText(WidgetTester tester) =>
        tester.widget<TextField>(find.byKey(field)).controller!.text;

    /// Fills the description with [text], as the reader's own edit.
    ///
    /// Typed first because only an edit the reader made sends a description at
    /// all, then written straight to the controller — which is how the sheet's
    /// own three writers write, and the one of them that can land past the cap
    /// is a rename arriving from another device.
    Future<void> writeDescription(WidgetTester tester, String text) async {
      await tester.enterText(find.byKey(field), 'x' * _descriptionMax);
      await tester.pumpAndSettle();
      tester.widget<TextField>(find.byKey(field)).controller!.text = text;
      await tester.pumpAndSettle();
    }

    Future<void> tapSave(WidgetTester tester) async {
      await tester.ensureVisible(find.byKey(save));
      await tester.tap(find.byKey(save));
    }

    testWidgets('a description at the cap is sent', (tester) async {
      final repository = await pumpCharacterEditorSheet(
        tester,
        testCharacter(),
      );

      await tester.enterText(find.byKey(field), 'x' * _descriptionMax);
      await tester.pumpAndSettle();
      expect(find.text('Too long to save.'), findsNothing);
      await tapSave(tester);
      await tester.pumpAndSettle();

      expect(repository.updates.single['description'], 'x' * _descriptionMax);
    });

    testWidgets('trailing whitespace over the cap is not a refusal', (
      tester,
    ) async {
      // Exactly at the cap once trimmed, and one grapheme over it as the field
      // holds it. Measuring the field's own text refused this save for a
      // newline zod strips before it counts anything — a refusal the reader
      // cannot see, over a description the route would have taken.
      final repository = await pumpCharacterEditorSheet(
        tester,
        testCharacter(),
      );
      await writeDescription(tester, '${'x' * _descriptionMax}\n');

      // The counter and the error measure the string the body carries, so
      // neither says a word about the newline. Saying "Too long to save." over
      // a save that goes through is a refusal the reader is told about and
      // cannot find, on whitespace nothing draws.
      expect(find.text('Too long to save.'), findsNothing);
      expect(find.text('2001/2000'), findsNothing);

      await tapSave(tester);
      await tester.pumpAndSettle();

      expect(repository.updates.single['description'], 'x' * _descriptionMax);
      expect(
        find.text('The description is too long. Shorten it and save again.'),
        findsNothing,
      );
    });

    testWidgets('one grapheme past the cap after trimming is refused', (
      tester,
    ) async {
      // The other side of the same boundary: whitespace on the ends buys the
      // body nothing, because the route trims before it counts too.
      final repository = await pumpCharacterEditorSheet(
        tester,
        testCharacter(),
      );
      await writeDescription(tester, '  ${'x' * (_descriptionMax + 1)}  ');

      await tapSave(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(repository.updates, isEmpty);
      expect(
        find.text('The description is too long. Shorten it and save again.'),
        findsOneWidget,
      );
      // Refused, not closed: the sheet is where the prose can be shortened.
      expect(find.text('Edit character'), findsOneWidget);
    });

    testWidgets('an edit made while past the cap keeps the whole tail', (
      tester,
    ) async {
      // Only a rename arriving from another device can put the field past the
      // cap, and the reader shortening it is exactly what they are asked to do.
      // Enforcing `maxLength` made that keystroke the destructive one: with the
      // field 13 over and the edit still over, `LengthLimitingTextInputFormatter`
      // returned `truncate(newValue, 2000)` — the end of the description and
      // the `@marker` in it gone, nowhere near where they were typing, again on
      // every keystroke after.
      await pumpCharacterEditorSheet(tester, testCharacter());
      await writeDescription(tester, '${'x' * _descriptionMax} @Alexandria.');
      expect(find.text('Too long to save.'), findsOneWidget);

      final shortened = descriptionText(tester).replaceFirst('x', '');
      await tester.enterText(find.byKey(field), shortened);
      await tester.pumpAndSettle();

      expect(descriptionText(tester), shortened);
      expect(descriptionText(tester).endsWith(' @Alexandria.'), isTrue);
      // Still over, and still saying so: the reader can see the length they
      // have left to lose.
      expect(find.text('2012/2000'), findsOneWidget);
    });

    testWidgets('a paste ten times over is refused whole, not shortened', (
      tester,
    ) async {
      // Ten times the cap is a document, and the reader gets it back entire
      // with a refusal — which is the whole point of leaving the field
      // unenforced. A `LengthLimitingTextInputFormatter` at the cap would have
      // answered this paste with its first 2000 characters and no way to see
      // what became of the rest.
      final repository = await pumpCharacterEditorSheet(
        tester,
        testCharacter(),
      );
      final pasted = 'x' * (_descriptionMax * 10);
      await tester.enterText(find.byKey(field), pasted);
      await tester.pumpAndSettle();

      expect(descriptionText(tester), pasted);
      expect(find.text('20000/2000'), findsOneWidget);

      await tapSave(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(repository.updates, isEmpty);
      expect(
        find.text('The description is too long. Shorten it and save again.'),
        findsOneWidget,
      );
      expect(find.text('Edit character'), findsOneWidget);
    });

    testWidgets('a paste no box could hold is clipped at the ceiling', (
      tester,
    ) async {
      // The bound on what may reach the field at all, spelled out rather than
      // derived so that moving it is a line somebody has to change here too.
      // Everything under it arrives whole — the test above — so this is the one
      // size that loses a tail, and it is a size nobody was going to shorten by
      // hand inside a six-line box.
      const ceiling = _descriptionMax * 20;
      final repository = await pumpCharacterEditorSheet(
        tester,
        testCharacter(),
      );

      await tester.enterText(find.byKey(field), 'x' * (_descriptionMax * 50));
      await tester.pumpAndSettle();

      expect(descriptionText(tester).length, ceiling);
      // Clipped and still refused: the ceiling is not a second opinion about
      // what a description may be, and nothing about hitting it turns a
      // manuscript into something this sheet will send.
      expect(find.text('$ceiling/$_descriptionMax'), findsOneWidget);
      await tapSave(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(repository.updates, isEmpty);
      expect(
        find.text('The description is too long. Shorten it and save again.'),
        findsOneWidget,
      );
    });

    testWidgets('past the cap the sheet resolves nothing, and says how far', (
      tester,
    ) async {
      // The `@name` half of this suite lives in
      // `character_editor_mentions_test.dart`, which is at its file-size
      // budget; what this is about is the cap, and that resolving stops at it.
      // Every keystroke used to re-sweep the whole description twice over — the
      // cost a paste this size multiplies — for a link set no save can carry:
      // prose over the cap is refused before any request goes out.
      final mina = testCharacter();
      await pumpCharacterEditorSheet(
        tester,
        mina,
        libraryCharacters: [mina, testCharacter(id: 'char-2', name: 'Nova')],
      );

      await tester.enterText(find.byKey(field), '${'x' * _descriptionMax} @Nova');
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('character-description-mentions')),
        findsNothing,
      );
      // Nor is a pick offered for the token under the caret: [_insertMention]
      // measures the cap first, so a strip here would refuse everything it
      // offered.
      expect(
        find.byKey(const ValueKey('character-mention-suggestions')),
        findsNothing,
      );
      // The one thing that does keep moving, because it is what the reader
      // shortens against.
      expect(find.text('2006/2000'), findsOneWidget);

      // And the first keystroke back under the cap resolves the lot.
      await tester.enterText(find.byKey(field), 'Friends with @Nova.');
      await tester.pumpAndSettle();

      expect(
        find.descendant(
          of: find.byKey(const ValueKey('character-description-mentions')),
          matching: find.text('@Nova'),
        ),
        findsOneWidget,
      );
    });
  });
}
