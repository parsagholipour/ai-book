import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_controller.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_painter.dart';
import 'package:tomeza/features/reader/presentation/reader_bottom_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_toolbar.dart';

import 'reader_annotation_controller_test.dart' show MemoryReaderRepository;

final _palette = readerMarkupPalette(onDarkPage: false);

Future<ReaderAnnotationController> _annotations() async {
  final controller = ReaderAnnotationController(
    repository: MemoryReaderRepository(),
    projectId: 'project-1',
    revision: 1,
  );
  await controller.load();
  return controller;
}

/// Puts the bar where the reader puts it and reports the height the body is
/// left with.
Future<Size> pumpBar(
  WidgetTester tester, {
  required ReaderAnnotationController annotations,
  int currentPage = 1,
  int pageCount = 13,
  String? chapterTitle,
  bool bookmarked = false,
  bool hasCoverPage = false,
  VoidCallback? onContents,
  VoidCallback? onToggleBookmark,
  VoidCallback? onListen,
}) async {
  late Size bodySize;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: LayoutBuilder(
          builder: (context, constraints) {
            bodySize = constraints.biggest;
            return const SizedBox.expand();
          },
        ),
        bottomNavigationBar: ReaderBottomChrome(
          annotations: annotations,
          palette: _palette,
          currentPage: currentPage,
          pageCount: pageCount,
          chapterTitle: chapterTitle,
          bookmarked: bookmarked,
          hasCoverPage: hasCoverPage,
          onContents: onContents ?? () {},
          onToggleBookmark: onToggleBookmark ?? () {},
          onListen: onListen ?? () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return bodySize;
}

void main() {
  testWidgets('leaves the page room to render', (tester) async {
    // The bar shares the slot with anything else in bottomNavigationBar, and
    // an unconstrained one takes the whole bounded height it is offered — the
    // body then collapses to zero and the book renders nothing at all.
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    final withBar = await pumpBar(tester, annotations: annotations);
    late Size withoutBar;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LayoutBuilder(
            builder: (context, constraints) {
              withoutBar = constraints.biggest;
              return const SizedBox.expand();
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(withBar.height, greaterThan(0));
    expect(
      withoutBar.height - withBar.height,
      lessThanOrEqualTo(ReaderBottomChrome.barHeight + 4),
      reason: 'the bar must cost no more than its declared height',
    );
  });

  testWidgets('states the place in the book', (tester) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    await pumpBar(
      tester,
      annotations: annotations,
      currentPage: 7,
      pageCount: 13,
      chapterTitle: 'The Harbour at Dusk',
    );

    expect(find.text('Page 7 of 13 · 54%'), findsOneWidget);
    expect(find.text('The Harbour at Dusk'), findsOneWidget);
  });

  testWidgets('says only the page when the book has no outline', (
    tester,
  ) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    await pumpBar(tester, annotations: annotations, currentPage: 2);

    expect(find.text('Page 2 of 13 · 15%'), findsOneWidget);
    // Buttons still there — the chapter is what is missing, not the bar.
    expect(find.byIcon(Icons.list_alt_outlined), findsOneWidget);
  });

  testWidgets('skips the cover in displayed numbers', (tester) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    await pumpBar(
      tester,
      annotations: annotations,
      currentPage: 1,
      pageCount: 10,
      hasCoverPage: true,
    );
    expect(find.text('Cover · 10%'), findsOneWidget);

    await pumpBar(
      tester,
      annotations: annotations,
      currentPage: 2,
      pageCount: 10,
      hasCoverPage: true,
    );
    expect(find.text('Page 1 of 9 · 20%'), findsOneWidget);
  });

  testWidgets('says nothing about a position it does not have yet', (
    tester,
  ) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    await pumpBar(tester, annotations: annotations, pageCount: 0);

    expect(find.textContaining('Page'), findsNothing);
    expect(find.byIcon(Icons.headphones_outlined), findsOneWidget);
  });

  testWidgets('reaches contents, bookmarks and listening', (tester) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);
    var contents = 0;
    var bookmark = 0;
    var listen = 0;

    await pumpBar(
      tester,
      annotations: annotations,
      onContents: () => contents++,
      onToggleBookmark: () => bookmark++,
      onListen: () => listen++,
    );

    await tester.tap(find.byIcon(Icons.list_alt_outlined));
    await tester.tap(find.byIcon(Icons.bookmark_outline));
    await tester.tap(find.byIcon(Icons.headphones_outlined));
    await tester.pumpAndSettle();

    expect(contents, 1);
    expect(bookmark, 1);
    expect(listen, 1);
  });

  testWidgets('fills the bookmark on a saved page', (tester) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);

    await pumpBar(tester, annotations: annotations, bookmarked: true);

    expect(find.byIcon(Icons.bookmark), findsOneWidget);
    expect(find.byIcon(Icons.bookmark_outline), findsNothing);
  });

  testWidgets('keeps the readout above the markup tray', (tester) async {
    final annotations = await _annotations();
    addTearDown(annotations.dispose);
    annotations.openMarkup();

    await pumpBar(tester, annotations: annotations, currentPage: 4);

    expect(find.byType(ReaderMarkupToolbar), findsOneWidget);
    // Panning is off while drawing, so the position readout has to survive the
    // tray opening or the reader loses track of where they are.
    expect(find.text('Page 4 of 13 · 31%'), findsOneWidget);
  });
}
