import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_stage.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

import '../../projects/book_page_fixtures.dart';
import '../../support/fake_studio_repository.dart';

// The book page of a book the author writes: the manuscript stage before the
// first publish, and the Studio as its Edit afterwards.

Future<void> _tall(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

const _unpublished = MobileManuscriptSummary(
  wordCount: 3200,
  chapterCount: 2,
  goalWords: 50000,
  published: false,
  hasUnpublishedChanges: true,
);

MobileProjectDetail _written({
  MobileManuscriptSummary? manuscript = _unpublished,
  String status = 'draft',
  bool withPlan = false,
}) => bookProject(
  status: status,
  source: 'written',
  withPlan: withPlan,
  pageCount: withPlan ? 16 : 0,
  prompt: 'Author-written manuscript: The Lighthouse Letter',
  manuscript: manuscript,
  statusLabel: 'Writing · 3,200 words',
  exports: exportSet(available: withPlan),
);

FakeStudioRepository _studio({List<FakeStudioChapter>? chapters}) =>
    FakeStudioRepository(
      projectId: 'project-1',
      title: 'The Lighthouse Letter',
      chapters:
          chapters ??
          [
            FakeStudioChapter(
              id: 'c1',
              title: 'The bottle',
              markdown: 'She found it at dawn.',
            ),
            FakeStudioChapter(
              id: 'c2',
              title: 'The answer',
              markdown: 'She wrote back that night.',
            ),
          ],
    );

void main() {
  group('bookStageFor', () {
    test('a written book never published is a manuscript, not a plan', () {
      expect(
        bookStageFor(
          project: _written(),
          status: bookStatus(status: 'draft'),
        ),
        BookStage.manuscript,
      );
      // Before the manuscript block arrives, "no plan" says the same thing.
      expect(
        bookStageFor(project: _written(manuscript: null)),
        BookStage.manuscript,
      );
    });

    test('a published written book takes the ordinary shape', () {
      const published = MobileManuscriptSummary(
        wordCount: 3200,
        chapterCount: 2,
        published: true,
        hasUnpublishedChanges: false,
      );
      expect(
        bookStageFor(
          project: _written(
            manuscript: published,
            status: 'complete',
            withPlan: true,
          ),
          status: bookStatus(),
        ),
        BookStage.ready,
      );
      // The publish's own compile is the book being prepared.
      expect(
        bookStageFor(
          project: _written(
            manuscript: published,
            status: 'editing',
            withPlan: true,
          ),
          status: bookStatus(status: 'editing'),
        ),
        BookStage.writing,
      );
    });

    test('imported and generated books are never a manuscript stage', () {
      expect(
        bookStageFor(
          project: bookProject(source: 'imported'),
          status: bookStatus(),
        ),
        BookStage.ready,
      );
      expect(
        bookStageFor(
          project: bookProject(status: 'draft', withPlan: false, pageCount: 0),
          status: bookStatus(status: 'draft'),
        ),
        BookStage.needsPlan,
      );
    });
  });

  testWidgets('the manuscript stage is the writing, not a plan to generate', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: _written(),
        status: bookStatus(status: 'draft', completed: 0),
        overrides: [
          studioRepositoryProvider.overrideWithValue(
            _studio()..goalWords = 50000,
          ),
        ],
      ),
    );
    // The book's own summary speaks until the working copy arrives.
    expect(find.text('3,200 words'), findsOneWidget);
    await tester.pumpAndSettle();

    expect(find.text('Writing'), findsOneWidget);
    expect(find.text('10 words'), findsOneWidget);
    expect(find.text('of your 50,000-word goal'), findsOneWidget);
    expect(find.text('The bottle'), findsOneWidget);
    expect(find.text('The answer'), findsOneWidget);
    // No plan, no generation, no scaffolding, no files.
    expect(find.text('Ready for a plan'), findsNothing);
    expect(find.text('Create book plan'), findsNothing);
    expect(find.textContaining('Author-written manuscript'), findsNothing);
    expect(find.text('Read'), findsNothing);
    expect(find.text('Exports'), findsNothing);

    await tester.tap(find.text('Continue writing'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/write']);
  });

  testWidgets('a chapter opens at itself, and Publish opens the sheet', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: _written(),
        status: bookStatus(status: 'draft', completed: 0),
        overrides: [studioRepositoryProvider.overrideWithValue(_studio())],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('The answer'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/write?chapter=c2']);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: _written(),
        status: bookStatus(status: 'draft', completed: 0),
        overrides: [studioRepositoryProvider.overrideWithValue(_studio())],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('studio-publish')));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/write?publish=1');
  });

  testWidgets('a blank manuscript starts writing and offers no publish', (
    tester,
  ) async {
    await _tall(tester);
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: _written(
          manuscript: const MobileManuscriptSummary(
            wordCount: 0,
            chapterCount: 1,
            published: false,
            hasUnpublishedChanges: false,
          ),
        ),
        status: bookStatus(status: 'draft', completed: 0),
        overrides: [
          studioRepositoryProvider.overrideWithValue(
            _studio(
              chapters: [
                FakeStudioChapter(id: 'c1', title: 'Chapter 1', markdown: ''),
              ],
            ),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Start writing'), findsOneWidget);
    expect(find.text('Set a word goal'), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-publish')), findsNothing);
  });

  testWidgets('Edit is the Studio for an author book, Edit Mode otherwise', (
    tester,
  ) async {
    await _tall(tester);
    const published = MobileManuscriptSummary(
      wordCount: 3200,
      chapterCount: 2,
      published: true,
      hasUnpublishedChanges: false,
    );
    final cases = {
      _written(manuscript: published, status: 'complete', withPlan: true): (
        'Write',
        '/projects/project-1/write',
      ),
      bookProject(source: 'imported'): ('Write', '/projects/project-1/write'),
      bookProject(): ('Edit', '/projects/project-1/edit'),
    };
    for (final entry in cases.entries) {
      final visited = <String>[];
      await tester.pumpWidget(
        bookPageApp(
          visited: visited,
          project: entry.key,
          status: bookStatus(),
          overrides: [studioRepositoryProvider.overrideWithValue(_studio())],
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text(entry.value.$1));
      await tester.pumpAndSettle();
      expect(visited, [entry.value.$2], reason: entry.key.source);
    }
  });

  testWidgets('unpublished Studio changes are named, with the way to publish', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: _written(
          manuscript: const MobileManuscriptSummary(
            wordCount: 3400,
            chapterCount: 2,
            published: true,
            hasUnpublishedChanges: true,
          ),
          status: 'complete',
          withPlan: true,
        ),
        status: bookStatus(),
        overrides: [studioRepositoryProvider.overrideWithValue(_studio())],
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('You have changes that aren\'t in your book yet'),
      findsOneWidget,
    );
    await tester.tap(find.text('Update book'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/write?publish=1']);
  });

  testWidgets('no unpublished-changes notice for a generated book', (
    tester,
  ) async {
    await _tall(tester);
    await tester.pumpWidget(
      bookPageApp(visited: [], project: bookProject(), status: bookStatus()),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('book-unpublished-changes')),
      findsNothing,
    );
  });

  testWidgets('quality notes on an author book open the Studio', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      bookPageApp(
        visited: visited,
        project: bookProject(source: 'imported'),
        status: bookStatus(quality: reviewQuality),
        overrides: [studioRepositoryProvider.overrideWithValue(_studio())],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Review recommended'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(visited, ['/projects/project-1/write']);
  });
}
