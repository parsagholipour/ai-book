import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_editor_sheet.dart';

import 'character_test_support.dart';

/// The editor sheet is the form and nothing else: a name, a description, some
/// details, and the one description the server read off a picture — which is
/// offered and never applied. Everything about the pictures themselves moved to
/// the character's own page; those assertions live in
/// `character_profile_test.dart`.
void main() {
  Future<FakeCharactersRepository> pumpSheet(
    WidgetTester tester,
    LibraryCharacter saved,
  ) async {
    final repository = FakeCharactersRepository(saved);
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
}
