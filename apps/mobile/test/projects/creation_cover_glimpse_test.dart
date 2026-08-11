import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_cover.dart';
import 'package:tomeza/features/projects/presentation/creation_cover_glimpse.dart';
import 'package:tomeza/features/projects/presentation/creation_labels.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  bool disableAnimations = false,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: disableAnimations),
          child: Scaffold(body: Center(child: child)),
        ),
      ),
    ),
  );
}

double _glimpseOpacity(WidgetTester tester) {
  return tester
      .widget<Opacity>(
        find.descendant(
          of: find.byType(CreationCoverGlimpse),
          matching: find.byType(Opacity),
        ),
      )
      .opacity;
}

void main() {
  testWidgets('solidity follows readiness and canBuild wins', (tester) async {
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: null,
        readinessScore: 0,
        canBuild: false,
        seed: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();
    expect(_glimpseOpacity(tester), closeTo(0.35, 0.001));

    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: null,
        readinessScore: 80,
        canBuild: false,
        seed: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();
    expect(_glimpseOpacity(tester), closeTo(0.87, 0.001));

    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: null,
        readinessScore: 80,
        canBuild: true,
        seed: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();
    expect(_glimpseOpacity(tester), 1.0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('real cover art is handed through to BookCover', (tester) async {
    const image = MobileProjectImage(
      id: 'cover-image',
      role: 'cover',
      url: '/api/mobile/projects/project-1/assets/cover-image',
      contentType: 'image/png',
      altText: 'Generated cover',
    );
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: 'Launch Course Workbook',
        readinessScore: 100,
        canBuild: true,
        seed: 'draft-1',
        image: image,
      ),
    );
    await tester.pumpAndSettle();
    // The param is the contract: under `flutter test` the network fetch
    // fails into BookCover's placeholder, which is fine and not asserted.
    expect(tester.widget<BookCover>(find.byType(BookCover)).image, image);

    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: 'Launch Course Workbook',
        readinessScore: 100,
        canBuild: true,
        seed: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<BookCover>(find.byType(BookCover)).image, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reduced motion lands on the final solidity without settling', (
    tester,
  ) async {
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: null,
        readinessScore: 100,
        canBuild: false,
        seed: 'draft-1',
      ),
      disableAnimations: true,
    );
    await tester.pump();
    expect(_glimpseOpacity(tester), 1.0);
  });

  testWidgets('stays a clean palette mark at helper-bar size', (tester) async {
    // At the default 28px the type cannot get smaller, only more cramped, so
    // the cover draws no text — the header's headline carries the title.
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: 'Moon Garden',
        readinessScore: 40,
        canBuild: false,
        seed: 'draft-1',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Moon Garden'), findsNothing);
    expect(find.text('Untitled book'), findsNothing);
  });

  testWidgets('typesets the working title once the tile is big enough', (
    tester,
  ) async {
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: 'Moon Garden',
        readinessScore: 40,
        canBuild: false,
        seed: 'draft-1',
        width: 56,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Moon Garden'), findsOneWidget);
  });

  testWidgets('paints the server palette when one is given', (tester) async {
    const palette = [Color(0xFF112233), Color(0xFF334455), Color(0xFF667788)];
    await _pump(
      tester,
      const CreationCoverGlimpse(
        title: 'Moon Garden',
        readinessScore: 40,
        canBuild: false,
        seed: 'draft-1',
        palette: palette,
      ),
    );
    await tester.pumpAndSettle();

    final gradients = tester
        .widgetList<DecoratedBox>(find.byType(DecoratedBox))
        .map((box) => box.decoration)
        .whereType<BoxDecoration>()
        .map((decoration) => decoration.gradient)
        .whereType<LinearGradient>();
    expect(
      gradients.any(
        (gradient) =>
            gradient.colors.length == 2 &&
            gradient.colors.first == palette[0] &&
            gradient.colors.last == palette[1],
      ),
      isTrue,
    );
  });

  group('workingCreationTitle', () {
    const details = MobileCreationOptionalDetails();

    test('prefers the chat-stated title and skips the New book default', () {
      expect(
        workingCreationTitle(
          optionalDetails: const MobileCreationOptionalDetails(title: 'Stated'),
          brief: const MobileBookRecipe(lane: 'auto', title: 'Brief title'),
          titleSuggestions: const ['Suggested'],
          sessionTitle: 'New book',
        ),
        'Stated',
      );
      expect(
        workingCreationTitle(
          optionalDetails: details,
          brief: const MobileBookRecipe(lane: 'auto', title: 'Brief title'),
          titleSuggestions: const [],
          sessionTitle: 'New book',
        ),
        'Brief title',
      );
      expect(
        workingCreationTitle(
          optionalDetails: details,
          brief: null,
          titleSuggestions: const ['Suggested'],
          sessionTitle: 'New book',
        ),
        'Suggested',
      );
      expect(
        workingCreationTitle(
          optionalDetails: details,
          brief: null,
          titleSuggestions: const [],
          sessionTitle: 'My renamed chat',
        ),
        'My renamed chat',
      );
      expect(
        workingCreationTitle(
          optionalDetails: details,
          brief: null,
          titleSuggestions: const [],
          sessionTitle: 'New book',
        ),
        isNull,
      );
    });
  });

  group('creationPitchLine', () {
    test('promise, then audience, then the type label', () {
      expect(
        creationPitchLine(
          brief: const MobileBookRecipe(
            lane: 'practical_guide',
            promise: 'Learn to price with confidence',
            audience: 'new freelancers',
          ),
          bookTypeChoiceLabel: 'Auto',
        ),
        'Learn to price with confidence',
      );
      expect(
        creationPitchLine(
          brief: const MobileBookRecipe(
            lane: 'practical_guide',
            audience: 'new freelancers',
          ),
          bookTypeChoiceLabel: 'Auto',
        ),
        'new freelancers',
      );
      expect(
        creationPitchLine(brief: null, bookTypeChoiceLabel: 'Auto'),
        'Auto',
      );
    });
  });

  group('coverPreviewColors', () {
    test('parses hex colours and rejects unusable palettes', () {
      expect(coverPreviewColors(null), isNull);
      expect(
        coverPreviewColors(
          const MobileCreationCoverPreview(
            designId: 'dusk-gradient',
            template: 'minimal',
            colors: ['#161a3a', '#3b3f7a', '#f0a868'],
          ),
        ),
        const [Color(0xFF161A3A), Color(0xFF3B3F7A), Color(0xFFF0A868)],
      );
      expect(
        coverPreviewColors(
          const MobileCreationCoverPreview(
            designId: 'broken',
            template: 'minimal',
            colors: ['#161a3a', 'not-a-colour'],
          ),
        ),
        isNull,
      );
    });
  });
}
