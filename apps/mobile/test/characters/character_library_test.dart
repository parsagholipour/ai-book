import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_library_card.dart';
import 'package:tomeza/features/characters/presentation/character_library_controls.dart';
import 'package:tomeza/features/characters/presentation/character_library_screen.dart';
import 'package:tomeza/features/characters/presentation/character_profile_screen.dart';

import 'character_test_support.dart';

void main() {
  final mina = testCharacter(hasPhoto: false).copyWith(
    fields: const [CharacterField(key: 'Likes', value: 'Thunderstorms')],
  );
  final fern = testCharacter(
    id: 'char-2',
    name: 'Captain Fern',
    description: 'A quiet explorer of the stars.',
    usedInBooks: true,
  );
  final otto = testCharacter(
    id: 'char-3',
    name: 'Otto',
    description: 'A mischievous fox.',
    photoKind: CharacterPhotoKind.photograph,
  ).copyWith(updatedAt: DateTime.utc(2026, 9));

  Future<void> pumpLibrary(
    WidgetTester tester, {
    List<LibraryCharacter>? characters,
    Size size = const Size(390, 1200),
    double textScale = 1,
    bool dark = false,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository(
              mina,
              libraryCharacters: characters ?? [mina, fern, otto],
            ),
          ),
        ],
        child: MaterialApp(
          theme: dark ? buildTomezaDarkTheme() : buildTomezaLightTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: const CharacterLibraryScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  List<String> visibleCards(WidgetTester tester) => tester
      .widgetList<CharacterLibraryCard>(find.byType(CharacterLibraryCard))
      .map((card) => card.character.name)
      .toList();

  testWidgets('search combines words across name, description, and details', (
    tester,
  ) async {
    await pumpLibrary(tester);
    await tester.enterText(
      find.byKey(const ValueKey('character-search')),
      ' MINA thunder ',
    );
    await tester.pumpAndSettle();
    expect(visibleCards(tester), ['Mina Park']);
    await tester.enterText(
      find.byKey(const ValueKey('character-search')),
      'stars',
    );
    await tester.pumpAndSettle();
    expect(visibleCards(tester), ['Captain Fern']);
    await tester.tap(find.byTooltip('Clear search'));
    await tester.pumpAndSettle();
    expect(visibleCards(tester).length, 3);
  });

  testWidgets('a photo-only card is labelled separately from book artwork', (
    tester,
  ) async {
    await pumpLibrary(tester);
    expect(find.text('Photo only · Illustrate next'), findsOneWidget);
    expect(find.text('Illustration ready'), findsOneWidget);
  });

  testWidgets('no results can reset search', (tester) async {
    await pumpLibrary(tester);
    await tester.enterText(
      find.byKey(const ValueKey('character-search')),
      'Nobody',
    );
    await tester.pumpAndSettle();
    expect(find.text('No characters here'), findsOneWidget);
    await tester.ensureVisible(find.text('Reset search'));
    await tester.tap(find.text('Reset search'));
    await tester.pumpAndSettle();
    expect(visibleCards(tester).length, 3);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('character-search')))
          .controller!
          .text,
      isEmpty,
    );
  });

  testWidgets('sort order changes without changing the library', (
    tester,
  ) async {
    await pumpLibrary(tester);
    expect(visibleCards(tester), ['Otto', 'Mina Park', 'Captain Fern']);
    await tester.tap(find.text('Recently updated'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(
        CheckedPopupMenuItem<CharacterLibrarySort>,
        'Name A–Z',
      ),
    );
    await tester.pumpAndSettle();
    expect(visibleCards(tester), ['Captain Fern', 'Mina Park', 'Otto']);
  });

  testWidgets('a card opens the character and its menu opens the editor', (
    tester,
  ) async {
    await pumpLibrary(tester);
    await tester.tap(find.byKey(const ValueKey('character-card-char-3')));
    await tester.pumpAndSettle();
    expect(find.byType(CharacterProfileScreen), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Actions for Otto'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit details'));
    await tester.pumpAndSettle();
    expect(find.text('Edit character'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Otto'), findsOneWidget);
  });

  testWidgets('empty library provides one clear create action', (tester) async {
    await pumpLibrary(tester, characters: []);
    expect(find.byKey(const ValueKey('character-search')), findsNothing);
    expect(find.text('New character'), findsNothing);
    await tester.tap(find.text('Create your first character'));
    await tester.pumpAndSettle();
    expect(find.text('New character'), findsOneWidget);
    expect(find.text('Create character'), findsOneWidget);
  });

  for (final dark in [false, true]) {
    testWidgets(
      'narrow library supports large text in ${dark ? 'dark' : 'light'} mode',
      (tester) async {
        await pumpLibrary(
          tester,
          size: const Size(320, 740),
          textScale: 2,
          dark: dark,
        );
        expect(tester.takeException(), isNull);
        await tester.drag(find.byType(CustomScrollView), const Offset(0, -450));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.text('New character').hitTestable(), findsOneWidget);
      },
    );
  }
}
