import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/presentation/chapter_outline_sheet.dart';
import 'package:tomeza/features/studio/presentation/studio_session.dart';
import 'package:tomeza/shared/api/api_client.dart';

import '../../support/fake_studio_characters.dart';
import '../../support/fake_studio_repository.dart';
import '../../support/studio_cover_test_support.dart';

// The story bible's people: the cast above the chapters. Every picture the
// Studio draws takes their looks from here, so the cast is saved whole, and a
// character leaves it without leaving the library.

List<LibraryCharacter> _library() => [
  studioCharacter(id: 'char-1', name: 'Mina Park', description: 'The keeper.'),
  studioCharacter(id: 'char-2', name: 'Theo Lark', description: 'Her brother.'),
  studioCharacter(id: 'char-3', name: 'Ava Stone', description: 'A sailor.'),
];

typedef _Open = ({FakeStudioRepository repo, FakeStudioCharacters characters});

Future<_Open> _openOutline(
  WidgetTester tester, {
  List<String> cast = const [],
}) async {
  final repo = FakeStudioRepository(title: 'The Lighthouse Letter')
    ..castCharacterIds = cast;
  final characters = FakeStudioCharacters(characters: _library());
  final session = StudioSession(
    projectId: 'p1',
    repository: repo,
    drafts: MemoryStudioLocalDrafts(),
  );
  addTearDown(session.dispose);
  await session.start();

  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        studioRepositoryProvider.overrideWithValue(repo),
        charactersRepositoryProvider.overrideWithValue(characters),
        appConfigProvider.overrideWithValue(coverTestConfig),
        apiAuthHeadersProvider.overrideWith(
          (ref) async => const <String, String>{},
        ),
      ],
      child: MaterialApp(
        theme: buildTomezaLightTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: TextButton(
                onPressed: () =>
                    showChapterOutlineSheet(context, session: session),
                child: const Text('Outline'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Outline'));
  await tester.pumpAndSettle();
  return (repo: repo, characters: characters);
}

List<String>? _savedCast(FakeStudioRepository repo) =>
    repo.settingsUpdates.last.castCharacterIds;

Finder _member(String id) => find.byKey(ValueKey('cast-member-$id'));

/// A row in the picker (the name alone is also on the strip behind it).
Finder _candidate(String id) => find.byKey(ValueKey('cast-candidate-$id'));

void main() {
  testWidgets('an empty cast is one quiet line, and the picker saves it', (
    tester,
  ) async {
    final open = await _openOutline(tester);

    expect(find.text('Cast'), findsOneWidget);
    expect(find.text('Add the characters in your book'), findsOneWidget);
    // An invitation, not a card to fill in: nothing else is asked yet.
    expect(find.byKey(const ValueKey('cast-add')), findsNothing);

    await tester.tap(find.text('Add the characters in your book'));
    await tester.pumpAndSettle();
    expect(find.text('Your cast'), findsOneWidget);
    expect(find.text('Done'), findsOneWidget);

    await tester.tap(find.text('Mina Park'));
    await tester.pump();
    await tester.tap(find.text('Theo Lark'));
    await tester.pump();
    await tester.tap(find.text('Save cast'));
    await tester.pumpAndSettle();

    expect(_savedCast(open.repo), ['char-1', 'char-2']);
    expect(find.text('Your cast'), findsNothing);
    expect(_member('char-1'), findsOneWidget);
    expect(_member('char-2'), findsOneWidget);
    expect(
      find.text(
        'Pictures of these characters stay consistent across your book.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('the picker sends the whole cast, not the change', (
    tester,
  ) async {
    final open = await _openOutline(tester, cast: ['char-2', 'char-1']);
    expect(_member('char-2'), findsOneWidget);
    expect(_member('char-1'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('cast-add')));
    await tester.pumpAndSettle();
    await tester.tap(_candidate('char-2'));
    await tester.pump();
    await tester.tap(_candidate('char-3'));
    await tester.pump();
    await tester.tap(find.text('Save cast'));
    await tester.pumpAndSettle();

    expect(_savedCast(open.repo), ['char-1', 'char-3']);
    expect(_member('char-2'), findsNothing);
    expect(_member('char-3'), findsOneWidget);
  });

  testWidgets('closing the picker unchanged saves nothing', (tester) async {
    final open = await _openOutline(tester, cast: ['char-1']);
    await tester.tap(find.byKey(const ValueKey('cast-add')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(open.repo.settingsUpdates, isEmpty);
  });

  testWidgets('a character made from the picker joins the cast', (
    tester,
  ) async {
    final open = await _openOutline(tester);
    await tester.tap(find.text('Add the characters in your book'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('New character'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Nora Vale');
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(open.characters.created, ['char-new-1']);
    // Back in the picker, already ticked.
    final tile = tester.widget<CheckboxListTile>(
      find.ancestor(
        of: find.text('Nora Vale'),
        matching: find.byType(CheckboxListTile),
      ),
    );
    expect(tile.value, isTrue);

    await tester.tap(find.text('Save cast'));
    await tester.pumpAndSettle();
    expect(_savedCast(open.repo), ['char-new-1']);
    expect(_member('char-new-1'), findsOneWidget);
  });

  testWidgets('a cast member leaves by their menu, and Undo brings them back', (
    tester,
  ) async {
    final open = await _openOutline(tester, cast: ['char-1', 'char-2']);

    await tester.longPress(_member('char-1'));
    await tester.pumpAndSettle();
    expect(find.text('Open character'), findsOneWidget);
    await tester.tap(find.text('Remove from cast'));
    await tester.pumpAndSettle();

    expect(_savedCast(open.repo), ['char-2']);
    expect(_member('char-1'), findsNothing);
    // Still in the library: only the book's cast changed.
    expect(open.characters.characters.map((c) => c.id), contains('char-1'));
    expect(find.text('Mina Park left the cast'), findsOneWidget);

    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(_savedCast(open.repo), ['char-1', 'char-2']);
    expect(_member('char-1'), findsOneWidget);
  });
}
