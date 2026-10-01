import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

FakeStudioRepository _repo() {
  final repo = FakeStudioRepository(
    title: 'The Lantern Keeper',
    chapters: [
      FakeStudioChapter(
        id: 'c1',
        title: 'Arrival',
        markdown: 'She came by sea.',
        status: ManuscriptChapterStatus.finalDraft,
        // Written in last, so it is the one that opens.
        updatedAt: DateTime.utc(2026, 10, 1),
      ),
      FakeStudioChapter(
        id: 'c2',
        title: 'The Harbour',
        markdown: 'Boats came home slowly.',
        status: ManuscriptChapterStatus.revised,
      ),
      FakeStudioChapter(
        id: 'c3',
        title: 'The Storm',
        markdown: '',
        status: ManuscriptChapterStatus.idea,
      ),
    ],
  );
  repo.goalWords = 1000;
  return repo;
}

Future<void> _openOutline(
  WidgetTester tester,
  FakeStudioRepository repo,
) async {
  await tester.pumpWidget(studioTestApp(repo: repo));
  await settle(tester);
  await tester.tap(find.byKey(const ValueKey('studio-bar-title')));
  await settle(tester);
}

Finder _row(String id) => find.byKey(ValueKey('outline-$id'));

void main() {
  testWidgets('lists every chapter with its status, words and the goal', (
    tester,
  ) async {
    await _openOutline(tester, _repo());
    expect(find.text('The Lantern Keeper'), findsOneWidget);
    expect(find.text('8 of 1,000 words'), findsOneWidget);
    expect(find.text('1%'), findsOneWidget);
    expect(
      find.descendant(of: _row('c1'), matching: find.text('Final')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _row('c2'), matching: find.text('4 words')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _row('c3'), matching: find.text('Idea')),
      findsOneWidget,
    );
    await closeStudio(tester);
  });

  testWidgets('tapping a chapter saves this one and opens that one', (
    tester,
  ) async {
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo));
    await settle(tester);
    await tester.enterText(bodyFields().first, 'She came by sea, alone.');
    await tester.tap(find.byKey(const ValueKey('studio-bar-title')));
    await settle(tester);

    await tester.tap(
      find.descendant(of: _row('c2'), matching: find.text('The Harbour')),
    );
    await settle(tester);
    expect(repo.saves.single.chapterId, 'c1');
    expect(repo.saves.single.markdown, 'She came by sea, alone.');
    expect(find.text('CHAPTER 2'), findsOneWidget);
    expect(find.text('Boats came home slowly.'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('Add chapter 4 goes at the end and opens, ready to be named', (
    tester,
  ) async {
    final repo = _repo();
    // The first chapter is open: the add still goes at the end, where the
    // button under the list says it will.
    await _openOutline(tester, repo);
    final add = find.byKey(const ValueKey('outline-new-chapter'));
    expect(
      find.descendant(of: add, matching: find.text('Add chapter 4')),
      findsOneWidget,
    );
    await tester.tap(add);
    await settle(tester);
    expect(repo.chapters.map((c) => c.title), [
      'Arrival',
      'The Harbour',
      'The Storm',
      'Chapter 4',
    ]);
    expect(find.text('Start writing…'), findsOneWidget);
    expect(find.textContaining('Chapter 4 of 4'), findsOneWidget);
    // The title has the cursor, its placeholder selected: typing names it.
    final title = tester.widget<TextField>(
      find.byKey(const ValueKey('studio-title-field')),
    );
    expect(title.focusNode!.hasFocus, isTrue);
    expect(
      title.controller!.selection,
      const TextSelection(baseOffset: 0, extentOffset: 9),
    );
    await closeStudio(tester);
  });

  testWidgets('a chapter\'s menu adds one right after it', (tester) async {
    final repo = _repo();
    await _openOutline(tester, repo);
    await tester.tap(
      find.descendant(of: _row('c2'), matching: find.byIcon(Icons.more_vert)),
    );
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('outline-add-after')));
    await settle(tester);
    expect(repo.chapters.map((c) => c.title), [
      'Arrival',
      'The Harbour',
      'Chapter 3',
      'The Storm',
    ]);
    expect(find.textContaining('Chapter 3 of 4'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('dragging a chapter reorders the book', (tester) async {
    final repo = _repo();
    await _openOutline(tester, repo);
    final handle = find.descendant(
      of: _row('c1'),
      matching: find.byIcon(Icons.drag_indicator_rounded),
    );
    final gesture = await tester.startGesture(tester.getCenter(handle));
    await tester.pump(const Duration(milliseconds: 100));
    for (var i = 0; i < 10; i++) {
      await gesture.moveBy(const Offset(0, 16));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await settle(tester);
    expect(repo.calls, contains('reorderChapters'));
    expect(repo.chapters.first.id, 'c2');
    await closeStudio(tester);
  });

  testWidgets('a deleted chapter can be brought back', (tester) async {
    final repo = _repo();
    await _openOutline(tester, repo);
    await tester.tap(
      find.descendant(
        of: _row('c2'),
        matching: find.byTooltip('Chapter options'),
      ),
    );
    await settle(tester);
    await tester.tap(find.text('Delete chapter'));
    await settle(tester);
    expect(_row('c2'), findsNothing);
    expect(find.text('“The Harbour” deleted'), findsOneWidget);

    await tester.tap(find.text('Undo'));
    await settle(tester);
    expect(repo.calls, contains('restoreChapter:c2'));
    expect(_row('c2'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('the last chapter says why it stays', (tester) async {
    final repo = FakeStudioRepository(
      chapters: [FakeStudioChapter(id: 'c1', title: 'Only', markdown: 'x')],
    );
    await _openOutline(tester, repo);
    await tester.tap(find.byTooltip('Chapter options'));
    await settle(tester);
    await tester.tap(find.text('Delete chapter'));
    await settle(tester);
    expect(
      find.text('A book needs at least one chapter, so this one stays.'),
      findsOneWidget,
    );
    expect(_row('c1'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('another chapter can be renamed and its status set', (
    tester,
  ) async {
    final repo = _repo();
    await _openOutline(tester, repo);
    await tester.tap(
      find.descendant(
        of: _row('c3'),
        matching: find.byTooltip('Chapter options'),
      ),
    );
    await settle(tester);
    await tester.tap(find.text('Rename'));
    await settle(tester);
    await tester.enterText(
      find.byKey(const ValueKey('studio-rename-field')),
      'The Great Storm',
    );
    await tester.tap(find.text('Save'));
    await settle(tester);
    expect(repo.saves.last.chapterId, 'c3');
    expect(repo.saves.last.title, 'The Great Storm');
    expect(
      find.descendant(of: _row('c3'), matching: find.text('The Great Storm')),
      findsOneWidget,
    );

    await tester.tap(
      find.descendant(
        of: _row('c3'),
        matching: find.byTooltip('Chapter options'),
      ),
    );
    await settle(tester);
    await tester.tap(find.text('Status'));
    await settle(tester);
    await tester.tap(find.text('Drafting'));
    await settle(tester);
    expect(repo.saves.last.status, ManuscriptChapterStatus.drafting);
    await closeStudio(tester);
  });

  testWidgets('on a wide screen the outline is a pane beside the page', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1024, 768);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo));
    await settle(tester);

    expect(_row('c1'), findsOneWidget);
    expect(find.byIcon(Icons.expand_more_rounded), findsNothing);
    await tester.tap(
      find.descendant(of: _row('c2'), matching: find.text('The Harbour')),
    );
    await settle(tester);
    expect(find.text('CHAPTER 2'), findsOneWidget);
    expect(_row('c1'), findsOneWidget, reason: 'the pane stays');

    // A deletion from the pane offers its undo in the page's snack bar.
    await tester.tap(
      find.descendant(
        of: _row('c3'),
        matching: find.byTooltip('Chapter options'),
      ),
    );
    await settle(tester);
    await tester.tap(find.text('Delete chapter'));
    await settle(tester);
    expect(find.byType(SnackBar), findsOneWidget);
    await closeStudio(tester);
  });
}
