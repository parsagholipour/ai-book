import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_painter.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_sheets.dart';
import 'package:tomeza/features/reader/presentation/reader_annotations_sheet.dart';
import 'package:tomeza/features/reader/presentation/reader_appearance_sheet.dart';

final palette = readerMarkupPalette(onDarkPage: false);

TextMarkupAnnotation highlight({
  String id = 'a1',
  int page = 3,
  String quote = 'The rabbit stretched in the long grass.',
  bool orphaned = false,
  int colorIndex = 0,
}) {
  return TextMarkupAnnotation(
    id: id,
    page: page,
    revision: 1,
    colorIndex: colorIndex,
    createdAt: DateTime.utc(2026, 7, 20),
    updatedAt: DateTime.utc(2026, 7, 20),
    style: ReaderMarkupStyle.highlight,
    rects: const [NormRect(0.1, 0.2, 0.4, 0.02)],
    quote: quote,
    orphaned: orphaned,
    bookPageIndex: 7,
  );
}

NoteAnnotation note({String body = 'Come back to this.'}) {
  return NoteAnnotation(
    id: 'n1',
    page: 5,
    revision: 1,
    colorIndex: 1,
    createdAt: DateTime.utc(2026, 7, 21),
    updatedAt: DateTime.utc(2026, 7, 21),
    anchor: const NormPoint(0.8, 0.3),
    body: body,
    quote: 'a passage worth arguing with',
  );
}

Future<void> pumpSheet(WidgetTester tester, Widget sheet) {
  return tester.pumpWidget(
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: sheet))),
  );
}

void main() {
  group('markup index', () {
    testWidgets('lists markup in page order with what it was made on', (
      tester,
    ) async {
      await pumpSheet(
        tester,
        ReaderAnnotationsSheet(
          annotations: [
            highlight(id: 'b', page: 9, quote: 'the later passage'),
            highlight(id: 'a', page: 2, quote: 'the earlier passage'),
          ],
          palette: palette,
          onSelect: (_) {},
          onRemove: (_) {},
          onShareAll: () {},
          canUndo: false,
          onUndo: () {},
        ),
      );

      final tiles = tester.widgetList<ListTile>(find.byType(ListTile)).toList();
      expect(tiles, hasLength(2));
      expect((tiles.first.title! as Text).data, 'the earlier passage');
      expect((tiles.last.title! as Text).data, 'the later passage');
    });

    testWidgets('separates markup that came loose, and will not jump to it', (
      tester,
    ) async {
      var jumped = false;
      await pumpSheet(
        tester,
        ReaderAnnotationsSheet(
          annotations: [highlight(orphaned: true, quote: 'a rewritten passage')],
          palette: palette,
          onSelect: (_) => jumped = true,
          onRemove: (_) {},
          onShareAll: () {},
          canUndo: false,
          onUndo: () {},
        ),
      );

      expect(find.text('From an earlier version'), findsOneWidget);
      await tester.tap(find.text('a rewritten passage'));
      await tester.pump();
      expect(
        jumped,
        isFalse,
        reason: 'there is no page to jump to any more',
      );
    });

    testWidgets('an empty book says how to start, and hides Share', (
      tester,
    ) async {
      await pumpSheet(
        tester,
        ReaderAnnotationsSheet(
          annotations: const [],
          palette: palette,
          onSelect: (_) {},
          onRemove: (_) {},
          onShareAll: () {},
          canUndo: false,
          onUndo: () {},
        ),
      );

      expect(find.textContaining('Select a passage to highlight it'), findsOneWidget);
      expect(find.text('Share'), findsNothing);
    });
  });

  group('share text', () {
    test('reads like notes someone took', () {
      final text = readerMarkupShareText(
        bookTitle: 'The Race',
        annotations: [
          highlight(id: 'b', page: 9, quote: 'the later passage'),
          note(),
          highlight(id: 'a', page: 2, quote: 'the earlier passage'),
        ],
      );

      expect(text, '''
The Race — my notes

Page 2
  "the earlier passage"

Page 5
  "a passage worth arguing with"
  — Come back to this.

Page 9
  "the later passage"''');
    });

    test('a drawing is listed so its page is not forgotten', () {
      final text = readerMarkupShareText(
        bookTitle: 'The Race',
        annotations: [
          InkAnnotation(
            id: 'i1',
            page: 4,
            revision: 1,
            colorIndex: 4,
            createdAt: DateTime.utc(2026),
            updatedAt: DateTime.utc(2026),
            strokes: const [
              InkStroke(
                points: [NormPoint(0, 0), NormPoint(1, 1)],
                colorIndex: 4,
                width: 0.004,
              ),
            ],
          ),
        ],
      );

      expect(text, contains('Page 4'));
      expect(text, contains('(Drawing)'));
    });

    test('an untitled book still gets a heading', () {
      expect(
        readerMarkupShareText(bookTitle: '', annotations: [highlight()]),
        startsWith('My notes'),
      );
    });
  });

  group('annotation sheet', () {
    testWidgets('a highlight offers the passage actions', (tester) async {
      await pumpSheet(
        tester,
        ReaderAnnotationSheet(
          annotation: highlight(),
          palette: palette,
          editingEnabled: true,
          onColorChanged: (_) {},
        ),
      );

      expect(find.text('Highlight · page 3'), findsOneWidget);
      expect(find.text('Ask about it'), findsOneWidget);
      expect(find.text('Rewrite it'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);
      // A highlight has no text of its own to edit and nothing to move.
      expect(find.text('Edit note'), findsNothing);
      expect(find.text('Move it'), findsNothing);
    });

    testWidgets('a note can be rewritten and moved', (tester) async {
      await pumpSheet(
        tester,
        ReaderAnnotationSheet(
          annotation: note(),
          palette: palette,
          editingEnabled: true,
          onColorChanged: (_) {},
        ),
      );

      expect(find.text('Note · page 5'), findsOneWidget);
      expect(find.text('Come back to this.'), findsOneWidget);
      expect(find.text('Edit note'), findsOneWidget);
      expect(find.text('Move it'), findsOneWidget);
    });

    testWidgets('editing actions go quiet while the book is busy', (
      tester,
    ) async {
      await pumpSheet(
        tester,
        ReaderAnnotationSheet(
          annotation: highlight(),
          palette: palette,
          editingEnabled: false,
          onColorChanged: (_) {},
        ),
      );

      ListTile tileFor(String label) => tester.widget<ListTile>(
        find.ancestor(of: find.text(label), matching: find.byType(ListTile)),
      );

      expect(tileFor('Rewrite it').enabled, isFalse);
      expect(tileFor('Edit this page').enabled, isFalse);
      expect(
        tileFor('Ask about it').enabled,
        isTrue,
        reason: 'asking changes nothing, so it is never blocked',
      );
    });

    testWidgets('recolouring applies at once and leaves the sheet open', (
      tester,
    ) async {
      final chosen = <int>[];
      await pumpSheet(
        tester,
        ReaderAnnotationSheet(
          annotation: highlight(),
          palette: palette,
          editingEnabled: true,
          onColorChanged: chosen.add,
        ),
      );

      await tester.tap(find.byTooltip('Green'));
      await tester.pump();
      await tester.tap(find.byTooltip('Blue'));
      await tester.pump();

      expect(chosen, [1, 2]);
      expect(find.byType(ReaderAnnotationSheet), findsOneWidget);
    });

    testWidgets('markup that came loose says so', (tester) async {
      await pumpSheet(
        tester,
        ReaderAnnotationSheet(
          annotation: highlight(orphaned: true),
          palette: palette,
          editingEnabled: true,
          onColorChanged: (_) {},
        ),
      );

      expect(
        find.textContaining('no longer in the book'),
        findsOneWidget,
      );
    });
  });

  group('appearance', () {
    testWidgets('every page tint is offered and reported', (tester) async {
      ReaderSettings? updated;
      await pumpSheet(
        tester,
        ReaderAppearanceSheet(
          settings: const ReaderSettings(),
          onChanged: (settings) => updated = settings,
        ),
      );

      for (final tint in ReaderPageTint.values) {
        expect(find.text(tint.label), findsOneWidget);
      }

      await tester.tap(find.text('Night'));
      await tester.pump();
      expect(updated?.tint, ReaderPageTint.night);
    });

    testWidgets('the brightness control says what it actually does', (
      tester,
    ) async {
      await pumpSheet(
        tester,
        ReaderAppearanceSheet(
          settings: const ReaderSettings(),
          onChanged: (_) {},
        ),
      );

      // A "brightness" slider that cannot go brighter than the phone reads as
      // broken unless it says so.
      expect(find.textContaining('Dims the page below'), findsOneWidget);
    });

    testWidgets('keeping the screen on is a switch that reports', (
      tester,
    ) async {
      ReaderSettings? updated;
      await pumpSheet(
        tester,
        ReaderAppearanceSheet(
          settings: const ReaderSettings(),
          onChanged: (settings) => updated = settings,
        ),
      );

      await tester.tap(find.text('Keep the screen on'));
      await tester.pump();

      expect(updated?.keepAwake, isTrue);
    });
  });

  group('note editor', () {
    testWidgets('shows the passage and hands back what was written', (
      tester,
    ) async {
      String? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  result = await showModalBottomSheet<String>(
                    context: context,
                    builder: (_) => const ReaderNoteSheet(
                      title: 'Note on this passage',
                      excerpt: 'The rabbit stretched.',
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Note on this passage'), findsOneWidget);
      expect(find.text('The rabbit stretched.'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '  a thought  ');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(result, 'a thought', reason: 'trimmed on the way out');
    });
  });
}
