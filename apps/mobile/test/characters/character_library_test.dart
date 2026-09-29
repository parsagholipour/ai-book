import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_library_card.dart';
import 'package:tomeza/features/characters/presentation/character_library_controls.dart';
import 'package:tomeza/features/characters/presentation/character_library_screen.dart';
import 'package:tomeza/features/characters/presentation/character_portrait_drawing.dart';
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
  // Search and sort only appear once the cast is a screenful, so most of these
  // suites run over five.
  final bram = testCharacter(
    id: 'char-4',
    name: 'Bram',
    description: '',
    hasPhoto: false,
  );
  final cora = testCharacter(
    id: 'char-5',
    name: 'Cora',
    description: '',
    hasPhoto: false,
  );

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
              libraryCharacters: characters ?? [mina, fern, otto, bram, cora],
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
    expect(visibleCards(tester).length, 5);
  });

  testWidgets('a photo-only card is labelled separately from book artwork', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pumpLibrary(tester);
    // A photo is a face to browse, not artwork a book can use, and the card
    // says so in words; a finished character carries a check instead of text.
    expect(find.text('Photo only'), findsOneWidget);
    expect(find.text('Illustration ready'), findsNothing);
    expect(
      find.bySemanticsLabel(RegExp('Captain Fern.*Illustration ready')),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel(RegExp('Otto.*Photo only, not illustrated yet')),
      findsOneWidget,
    );
    semantics.dispose();
  });

  testWidgets('a portrait being drawn is on the card, not only in its label', (
    tester,
  ) async {
    final drawing = testCharacter(
      id: 'char-6',
      name: 'Nova',
      hasPhoto: false,
      portraitStatus: CharacterPortraitStatus.generating,
    );
    // The veil animates for as long as the server says work is in flight, so
    // this never settles: pump frames instead.
    tester.view.physicalSize = const Size(390, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository(drawing, libraryCharacters: [drawing]),
          ),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const CharacterLibraryScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Drawing'), findsOneWidget);
    expect(find.byType(CharacterDrawingOverlay), findsOneWidget);
  });

  testWidgets('a small cast has no search box or sort menu', (tester) async {
    await pumpLibrary(tester, characters: [mina, fern, otto]);
    expect(find.byKey(const ValueKey('character-search')), findsNothing);
    expect(find.byTooltip('Sort characters'), findsNothing);
    expect(visibleCards(tester).length, 3);
  });

  testWidgets('the layout toggle swaps cards for rows', (tester) async {
    await pumpLibrary(tester);
    expect(find.byType(CharacterLibraryCard), findsWidgets);
    await tester.tap(find.byTooltip('Show as list'));
    await tester.pumpAndSettle();
    expect(find.byType(CharacterLibraryCard), findsNothing);
    expect(find.byType(CharacterLibraryRow), findsWidgets);
    await tester.tap(find.byTooltip('Show as grid'));
    await tester.pumpAndSettle();
    expect(find.byType(CharacterLibraryCard), findsWidgets);
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
    expect(visibleCards(tester).length, 5);
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
    expect(visibleCards(tester), [
      'Otto',
      'Mina Park',
      'Captain Fern',
      'Bram',
      'Cora',
    ]);
    // The current sort is named beside the count.
    expect(find.textContaining('Recently updated'), findsOneWidget);
    await tester.tap(find.byTooltip('Sort characters'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(
        CheckedPopupMenuItem<CharacterLibrarySort>,
        'Name A–Z',
      ),
    );
    await tester.pumpAndSettle();
    expect(visibleCards(tester), [
      'Bram',
      'Captain Fern',
      'Cora',
      'Mina Park',
      'Otto',
    ]);
    expect(find.textContaining('Name A–Z'), findsOneWidget);
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
        expect(find.text('Add character').hitTestable(), findsOneWidget);
      },
    );
  }
}
