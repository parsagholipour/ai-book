import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/reader_annotation_painter.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_overlays.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_actions.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_menu.dart';

const placed = ReaderSelection(
  text: 'The rabbit stretched in the long grass.',
  pdfPageNumber: 4,
  bookPageIndex: 12,
  placed: true,
);

Future<void> pumpMenu(
  WidgetTester tester, {
  ReaderSelection selection = placed,
  void Function(ReaderSelectionAction action)? onAction,
  bool editingEnabled = true,
}) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          // The same width the overlay gives it in the reader, so the layout
          // measured here is the layout that ships.
          child: SizedBox(
            width: ReaderSelectionOverlay.menuWidthFor(800),
            child: ReaderSelectionMenu(
              selection: selection,
              editingEnabled: editingEnabled,
              onAction: onAction ?? (_) {},
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> pumpMarkupBar(
  WidgetTester tester, {
  void Function(ReaderMarkupStyle style, int colorIndex)? onMarkup,
  void Function(ReaderSelectionAction action)? onAction,
  VoidCallback? onNote,
  VoidCallback? onDismiss,
  int defaultColorIndex = 0,
}) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        appBar: ReaderMarkupBar(
          palette: readerMarkupPalette(onDarkPage: false),
          defaultColorIndex: defaultColorIndex,
          onMarkup: onMarkup ?? (_, _) {},
          onNote: onNote ?? () {},
          onAction: onAction ?? (_) {},
          onDismiss: onDismiss ?? () {},
        ),
        body: const SizedBox.shrink(),
      ),
    ),
  );
}

void main() {
  testWidgets('every book action is visible, labelled and inside the bar', (
    tester,
  ) async {
    // The regression this exists for, twice over. Seven icons in one 320-pixel
    // scroller fitted four, and Replace, Edit page and Share sat past the right
    // edge with nothing to say they were there. Folding them behind a single
    // "Ask or edit" row then put the app's whole purpose one tap further away
    // than the highlighter. They are the body of the bar now.
    await pumpMenu(tester);
    await tester.pumpAndSettle();

    final bar = tester.getRect(find.byType(ReaderSelectionMenu));
    for (final label in const ['Ask', 'Rewrite', 'Replace', 'Edit page']) {
      expect(find.text(label), findsOneWidget, reason: '"$label" is missing');
      final item = tester.getRect(find.text(label));
      expect(
        item.left >= bar.left && item.right <= bar.right,
        isTrue,
        reason: '"$label" is outside the bar',
      );
    }
  });

  testWidgets('the book actions share the width equally', (tester) async {
    // None of the four is the afterthought, so none of them is smaller.
    await pumpMenu(tester);
    await tester.pumpAndSettle();

    final widths = [
      for (final label in const ['Ask', 'Rewrite', 'Replace', 'Edit page'])
        tester
            .getRect(
              find
                  .ancestor(
                    of: find.text(label),
                    matching: find.byType(InkWell),
                  )
                  .first,
            )
            .width,
    ];
    expect(widths.toSet(), hasLength(1));
  });

  testWidgets('shows nothing but the actions when all is well', (
    tester,
  ) async {
    // The book page a passage resolved to is our bookkeeping, not the
    // reader's: they are looking at a rendered PDF page, and Page.index is a
    // different number for the same place. Showing it invites a correction to
    // something that was almost certainly already right.
    await pumpMenu(tester);

    expect(
      tester.widgetList<Text>(find.byType(Text)).map((text) => text.data),
      ['Ask', 'Rewrite', 'Replace', 'Edit page'],
      reason: 'the four labels and nothing else',
    );
  });

  testWidgets('says nothing while the page is still being worked out', (
    tester,
  ) async {
    await pumpMenu(
      tester,
      selection: const ReaderSelection(text: 'a passage', pdfPageNumber: 4),
    );

    expect(
      tester.widgetList<Text>(find.byType(Text)).map((text) => text.data),
      ['Ask', 'Rewrite', 'Replace', 'Edit page'],
    );
    // Every action is live regardless: the message carries the quoted excerpt
    // as well as the page, so the server can find the passage either way.
    expect(find.text('Rewrite'), findsOneWidget);
  });

  testWidgets('a busy book greys the editing actions but never Ask', (
    tester,
  ) async {
    final tapped = <ReaderSelectionAction>[];
    await pumpMenu(
      tester,
      editingEnabled: false,
      onAction: tapped.add,
    );

    // The only thing worth a second row: three of the four actions have just
    // greyed out and nothing else on screen says why.
    expect(find.text('The book is busy — editing paused'), findsOneWidget);

    await tester.tap(find.text('Ask'));
    await tester.tap(find.text('Rewrite'));
    await tester.tap(find.text('Edit page'));
    await tester.pump();

    expect(tapped, [ReaderSelectionAction.ask]);
  });

  testWidgets('each book action reports itself', (tester) async {
    final tapped = <ReaderSelectionAction>[];
    await pumpMenu(tester, onAction: tapped.add);

    for (final label in const ['Ask', 'Rewrite', 'Replace', 'Edit page']) {
      await tester.tap(find.text(label));
    }
    await tester.pump();

    expect(tapped, [
      ReaderSelectionAction.ask,
      ReaderSelectionAction.rewrite,
      ReaderSelectionAction.replace,
      ReaderSelectionAction.editPage,
    ]);
  });

  group('markup bar', () {
    testWidgets('holds every markup control, at the top of the screen', (
      tester,
    ) async {
      // Moved off the floating bar so that bar could halve in height and stop
      // covering the paragraph it is about to rewrite.
      await pumpMarkupBar(tester);

      for (final label in const [
        'Yellow highlight',
        'Green highlight',
        'Blue highlight',
        'Pink highlight',
        'Underline',
        'Strike through',
        'Add a note',
        'Copy',
        'Share',
        'Done',
      ]) {
        expect(find.byTooltip(label), findsOneWidget, reason: 'missing $label');
      }
    });

    testWidgets('a colour is one tap', (tester) async {
      final marks = <(ReaderMarkupStyle, int)>[];
      await pumpMarkupBar(
        tester,
        onMarkup: (style, color) => marks.add((style, color)),
      );

      await tester.tap(find.byTooltip('Green highlight'));
      await tester.tap(find.byTooltip('Pink highlight'));
      await tester.pump();

      expect(marks, [
        (ReaderMarkupStyle.highlight, 1),
        (ReaderMarkupStyle.highlight, 3),
      ]);
    });

    testWidgets('underline and strike use the last colour picked', (
      tester,
    ) async {
      final marks = <(ReaderMarkupStyle, int)>[];
      await pumpMarkupBar(
        tester,
        defaultColorIndex: 2,
        onMarkup: (style, color) => marks.add((style, color)),
      );

      await tester.tap(find.byTooltip('Underline'));
      await tester.tap(find.byTooltip('Strike through'));
      await tester.pump();

      expect(marks, [
        (ReaderMarkupStyle.underline, 2),
        (ReaderMarkupStyle.strikethrough, 2),
      ]);
    });

    testWidgets('copy and share go through the passage actions', (
      tester,
    ) async {
      final tapped = <ReaderSelectionAction>[];
      await pumpMarkupBar(tester, onAction: tapped.add);

      await tester.tap(find.byTooltip('Copy'));
      await tester.tap(find.byTooltip('Share'));
      await tester.pump();

      expect(tapped, [
        ReaderSelectionAction.copy,
        ReaderSelectionAction.share,
      ]);
    });

    testWidgets('closing it drops the selection', (tester) async {
      var dismissed = 0;
      await pumpMarkupBar(tester, onDismiss: () => dismissed++);

      await tester.tap(find.byTooltip('Done'));
      await tester.pump();

      expect(dismissed, 1);
    });

    testWidgets('the colours survive a narrow bar, the share icon does not', (
      tester,
    ) async {
      // Reversed scrolling: when the row is wider than the screen it is the
      // rightmost icons that run off, never the swatches.
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await pumpMarkupBar(tester);
      await tester.pumpAndSettle();

      final bar = tester.getRect(find.byType(AppBar));
      final yellow = tester.getRect(find.byTooltip('Yellow highlight'));
      expect(yellow.left >= bar.left && yellow.right <= bar.right, isTrue);
    });
  });

  group('rewrite presets', () {
    testWidgets('a common change is one tap', (tester) async {
      String? instruction;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  instruction = await showModalBottomSheet<String>(
                    context: context,
                    builder: (_) => const ReaderInstructionSheet(
                      excerpt: 'The rabbit stretched.',
                      placement: 'Page 12',
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

      expect(find.text('Page 12'), findsOneWidget);
      await tester.tap(find.text('Make it shorter'));
      await tester.pumpAndSettle();

      expect(instruction, 'Make it shorter');
    });

    test('a preset composes the message the API classifier reads', () {
      // The wording is the contract with pageIndexesFromMessage and
      // quotedTexts in apps/api/src/bookEditIntent.ts.
      expect(
        readerRewriteMessage(
          pageIndex: 12,
          excerpt: 'The rabbit stretched.',
          instruction: readerRewritePresets.first,
        ),
        'On page 12, rewrite this passage: "The rabbit stretched.". '
        'Make it shorter',
      );
    });
  });
}
