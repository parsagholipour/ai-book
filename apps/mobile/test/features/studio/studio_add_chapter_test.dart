import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

// The two ways to add a chapter without opening the outline: the end of the
// chapter being written, and the menu.

FakeStudioRepository _repo({ManuscriptLayout layout = ManuscriptLayout.flow}) =>
    FakeStudioRepository(
      layout: layout,
      chapters: [
        FakeStudioChapter(
          id: 'c1',
          title: 'Arrival',
          markdown: 'She came by sea.',
          // Written in last, so it is the one that opens.
          updatedAt: DateTime.utc(2026, 10, 1),
        ),
        FakeStudioChapter(
          id: 'c2',
          title: 'The Harbour',
          markdown: 'Boats came home slowly.',
        ),
      ],
    );

Finder _chapterEnd() => find.byKey(const ValueKey('studio-chapter-end-add'));

TextField _title(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const ValueKey('studio-title-field')));

Future<void> _tapChapterEnd(WidgetTester tester) async {
  await tester.ensureVisible(_chapterEnd());
  await settle(tester);
  await tester.tap(_chapterEnd());
  await settle(tester);
}

void main() {
  testWidgets('the last chapter ends with Add chapter 3', (tester) async {
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo, chapterId: 'c2'));
    await settle(tester);

    expect(find.text('End of chapter 2'), findsOneWidget);
    expect(
      find.descendant(of: _chapterEnd(), matching: find.text('Add chapter 3')),
      findsOneWidget,
    );
    await _tapChapterEnd(tester);

    expect(repo.chapters.map((c) => c.title), [
      'Arrival',
      'The Harbour',
      'Chapter 3',
    ]);
    expect(find.textContaining('Chapter 3 of 3'), findsOneWidget);
    expect(_title(tester).focusNode!.hasFocus, isTrue);
    expect(_title(tester).controller!.text, 'Chapter 3');
    // The new chapter is the last now, so it offers the next one in turn.
    expect(find.text('End of chapter 3'), findsOneWidget);
    expect(find.text('Add chapter 4'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('an earlier chapter ends with a new one right after it', (
    tester,
  ) async {
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo));
    await settle(tester);

    expect(find.text('End of chapter 1'), findsOneWidget);
    expect(
      find.descendant(
        of: _chapterEnd(),
        matching: find.text('Add a chapter after this one'),
      ),
      findsOneWidget,
    );
    await tester.enterText(bodyFields().first, 'She came by sea, alone.');
    await _tapChapterEnd(tester);

    // What was typed is saved before the new chapter opens.
    expect(repo.saves.single.markdown, 'She came by sea, alone.');
    expect(repo.chapters.map((c) => c.title), [
      'Arrival',
      'Chapter 2',
      'The Harbour',
    ]);
    expect(find.textContaining('Chapter 2 of 3'), findsOneWidget);
    expect(_title(tester).focusNode!.hasFocus, isTrue);
    await closeStudio(tester);
  });

  testWidgets('the menu adds at the end, whichever chapter is open', (
    tester,
  ) async {
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo));
    await settle(tester);

    await tester.tap(find.byKey(const ValueKey('studio-more')));
    await settle(tester);
    await tester.tap(find.text('Add chapter 3'));
    await settle(tester);

    expect(repo.chapters.map((c) => c.title), [
      'Arrival',
      'The Harbour',
      'Chapter 3',
    ]);
    expect(find.textContaining('Chapter 3 of 3'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('a picture book keeps its own Add page and no chapter end', (
    tester,
  ) async {
    await tester.pumpWidget(
      studioTestApp(repo: _repo(layout: ManuscriptLayout.picture)),
    );
    await settle(tester);

    expect(_chapterEnd(), findsNothing);
    expect(find.textContaining('End of chapter'), findsNothing);
    await closeStudio(tester);
  });
}
