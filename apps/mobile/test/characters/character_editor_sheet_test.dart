import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_editor_sheet.dart';

import 'character_test_support.dart';

/// Eleven library names, one past the ten a description may mention. None is a
/// sub-token of another, so each `@name` resolves on its own.
const _mentionNames = [
  'Ana',
  'Bea',
  'Cyd',
  'Dee',
  'Eve',
  'Fay',
  'Gus',
  'Hal',
  'Ivy',
  'Jo',
  'Kim',
];

/// The editor sheet is the form and nothing else: a name, a description, some
/// details, and the one description the server read off a picture — which is
/// offered and never applied. Everything about the pictures themselves moved to
/// the character's own page; those assertions live in
/// `character_profile_test.dart`.
void main() {
  Future<FakeCharactersRepository> pumpSheet(
    WidgetTester tester,
    LibraryCharacter saved, {
    List<LibraryCharacter>? libraryCharacters,
  }) async {
    final repository = FakeCharactersRepository(
      saved,
      libraryCharacters: libraryCharacters,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [charactersRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () =>
                    showCharacterEditorSheet(context, character: saved),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return repository;
  }

  testWidgets('offers the suggestion without touching the description', (
    tester,
  ) async {
    await pumpSheet(
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
    final repository = await pumpSheet(
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
    final repository = await pumpSheet(
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
    await pumpSheet(tester, testCharacter());
    expect(find.text('Suggested from your photo'), findsNothing);
  });

  testWidgets('the form holds no pictures at all', (tester) async {
    // Everything about a picture moved to the character's page. A sheet that
    // still drew a face here would be the waypoint this split removed.
    await pumpSheet(
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

  testWidgets('typing @ offers another character and saves its durable id', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @',
    );
    await tester.pumpAndSettle();
    final suggestions = find.byKey(
      const ValueKey('character-mention-suggestions'),
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Bram')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Mina Park')),
      findsNothing,
    );

    await tester.tap(
      find.descendant(of: suggestions, matching: find.text('Bram')),
    );
    await tester.pumpAndSettle();
    expect(find.text('@Bram'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('character-editor-save')),
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['description'], 'Friends with @Bram');
    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
  });

  testWidgets('removing a saved token sends an authoritative empty link set', (
    tester,
  ) async {
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final mina = testCharacter(
      description: 'Friends with @Bram.',
      mentions: const [CharacterMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    expect(
      find.byKey(const ValueKey('character-description-mentions')),
      findsOneWidget,
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with @Bram.'),
      'Friends with Bram.',
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], isEmpty);
  });

  testWidgets('an unambiguous manually typed name resolves without a tap', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @Bram',
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const ValueKey('character-editor-save')),
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
  });

  testWidgets('a legacy @name the sheet resolved on its own is not a change', (
    tester,
  ) async {
    // A pre-feature character: plain prose, no durable link, and a description
    // the photo read that is still on offer. The sheet resolves the token as
    // soon as the library arrives, which must not turn a look-and-Save into a
    // PATCH — that one canonicalizes the prose, writes a link the reader never
    // made, and retires the suggestion they never acted on.
    final mina = testCharacter(
      description: 'Inspired by @bram',
      suggestedDescription: 'A girl in a yellow raincoat.',
    );
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    // The chip is the proof that the auto-resolution happened.
    expect(
      find.byKey(const ValueKey('character-description-mentions')),
      findsOneWidget,
    );

    await tester.ensureVisible(
      find.byKey(const ValueKey('character-editor-save')),
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates, isEmpty);
    expect(find.text('Edit character'), findsNothing);
  });

  testWidgets('a chip that still fits at the cap is inserted', (tester) async {
    final mina = testCharacter(description: '');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    await pumpSheet(tester, mina, libraryCharacters: [mina, bram]);

    final field = find.byKey(const ValueKey('character-description-field'));
    await tester.enterText(field, '${'x' * 1993} @');
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Bram'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final controller = tester.widget<TextField>(field).controller!;
    expect(controller.text.length, 2000);
    expect(controller.text.endsWith('@Bram '), isTrue);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('a chip that would pass the cap is refused, changing nothing', (
    tester,
  ) async {
    // The tap writes the controller directly, so the field's maxLength
    // formatter never runs over it — without the check the description goes
    // past the server's cap and the save comes back as a generic error with a
    // hidden counter and nothing on screen to explain it.
    final mina = testCharacter(description: '');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    await pumpSheet(tester, mina, libraryCharacters: [mina, bram]);

    final field = find.byKey(const ValueKey('character-description-field'));
    final typed = '${'x' * 1994} @';
    await tester.enterText(field, typed);
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Bram'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.widget<TextField>(field).controller!.text, typed);
    expect(
      find.text('That would make the description too long.'),
      findsOneWidget,
    );
  });

  testWidgets('the eleventh mention chip is refused', (tester) async {
    final mina = testCharacter(description: '');
    final others = [
      for (var index = 0; index < _mentionNames.length; index++)
        testCharacter(id: 'char-${index + 2}', name: _mentionNames[index]),
    ];
    await pumpSheet(tester, mina, libraryCharacters: [mina, ...others]);

    final field = find.byKey(const ValueKey('character-description-field'));
    final tokens = _mentionNames.take(10).map((name) => '@$name').join(' ');
    // The trailing fragment narrows the suggestion row to the one chip.
    await tester.enterText(field, 'Knows $tokens @Ki');
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Kim'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(
      tester.widget<TextField>(field).controller!.text,
      'Knows $tokens @Ki',
    );
    expect(
      find.text('A description can mention up to 10 characters.'),
      findsOneWidget,
    );
  });

  testWidgets('a save carrying more mentions than the cap is refused', (
    tester,
  ) async {
    // The resolver used to trim the set to the cap, so a save quietly deleted
    // a link the reader could still see in their own prose. Saying so is the
    // only honest answer.
    final mina = testCharacter(description: '');
    final others = [
      for (var index = 0; index < _mentionNames.length; index++)
        testCharacter(id: 'char-${index + 2}', name: _mentionNames[index]),
    ];
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, ...others],
    );

    final tokens = _mentionNames.map((name) => '@$name').join(' ');
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Knows $tokens.',
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const ValueKey('character-editor-save')),
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(repository.updates, isEmpty);
    expect(find.textContaining('mention up to 10 characters'), findsOneWidget);
    expect(find.text('Edit character'), findsOneWidget);
  });

  testWidgets('a case-ambiguous typed name remains unlinked until picked', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final upper = testCharacter(id: 'char-2', name: 'Bram');
    final lower = testCharacter(id: 'char-3', name: 'bram');
    final repository = await pumpSheet(
      tester,
      mina,
      libraryCharacters: [mina, upper, lower],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @BRAM',
    );
    await tester.pumpAndSettle();
    final suggestions = find.byKey(
      const ValueKey('character-mention-suggestions'),
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Bram')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('bram')),
      findsOneWidget,
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('character-editor-save')),
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], isEmpty);
  });
}
