import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/notes/data/book_notes_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen_body.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/shared/api/api_client.dart';

import '../../projects/book_page_fixtures.dart';
import '../../support/fake_studio_repository.dart';
import 'fake_book_notes_repository.dart';
import 'notes_test_harness.dart';

// The book page's door to its notes, in the stages a book can be in.

Widget _page({
  required MobileProjectDetail project,
  required FakeBookNotesRepository repo,
  required List<String> visited,
  FakeStudioRepository? studio,
}) {
  Widget elsewhere(BuildContext context, GoRouterState state) {
    visited.add(state.uri.toString());
    return const Scaffold(body: Text('elsewhere'));
  }

  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: BookScreenBody(
            project: project,
            status: bookStatus(status: project.status),
            billing: creditsBilling,
            revisionController: TextEditingController(),
            onRefresh: () async {},
            onOpen: (_) async {},
            onDownload: (_) async {},
            onOpenPaywall: (_) async {},
            onDeleteProject: () async {},
          ),
        ),
      ),
      GoRoute(path: '/projects/:id/:page', builder: elsewhere),
      GoRoute(path: '/projects/:id/:page/:sub', builder: elsewhere),
    ],
  );
  return ProviderScope(
    overrides: [
      bookNotesRepositoryProvider.overrideWithValue(repo),
      appConfigProvider.overrideWithValue(notesTestConfig),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      if (studio != null) studioRepositoryProvider.overrideWithValue(studio),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

Future<void> _tall(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

MobileProjectDetail _studioBook() => bookProject(
  status: 'draft',
  source: 'written',
  withPlan: false,
  pageCount: 0,
  prompt: 'Author-written manuscript: The Lighthouse Letter',
  manuscript: const MobileManuscriptSummary(
    wordCount: 3200,
    chapterCount: 1,
    goalWords: 50000,
    published: false,
    hasUnpublishedChanges: true,
  ),
  exports: exportSet(available: false),
);

FakeStudioRepository _studio() => FakeStudioRepository(
  projectId: 'project-1',
  title: 'The Lighthouse Letter',
  chapters: [
    FakeStudioChapter(id: 'c1', title: 'The bottle', markdown: 'At dawn.'),
  ],
);

void main() {
  testWidgets('a finished book shows its count and the last notes written in', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    final repo = FakeBookNotesRepository(
      notes: [
        fakeNote(
          'old',
          title: 'Old but pinned',
          pinned: true,
          ago: const Duration(days: 9),
        ),
        fakeNote('mid', title: 'Timeline', ago: const Duration(hours: 5)),
        fakeNote(
          'new',
          body: 'Green glass?\nMaybe',
          ago: const Duration(minutes: 3),
        ),
      ],
    );
    await tester.pumpWidget(
      _page(project: bookProject(), repo: repo, visited: visited),
    );
    await tester.pumpAndSettle();

    expect(find.text('Notes · 3'), findsOneWidget);
    // The two most recently edited, whatever their pin.
    expect(find.text('Green glass?'), findsOneWidget);
    expect(find.text('Timeline'), findsOneWidget);
    expect(find.text('Old but pinned'), findsNothing);
    // Below the book, above what would delete it.
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('book-notes-card'))).dy,
      lessThan(tester.getTopLeft(find.text('Delete project')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('book-notes-card'))).dy,
      greaterThan(tester.getTopLeft(find.text('Read')).dy),
    );

    await tester.tap(find.text('Timeline'));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/notes/mid');
  });

  testWidgets('the heading opens the list, and + starts a note', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    final repo = FakeBookNotesRepository(notes: [fakeNote('a', title: 'A')]);
    await tester.pumpWidget(
      _page(project: bookProject(), repo: repo, visited: visited),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('book-notes-open')));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/notes');
    Navigator.of(tester.element(find.text('elsewhere'))).pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('New note'));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/notes/new');
  });

  testWidgets('a Studio book with no notes is invited to add one', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    await tester.pumpWidget(
      _page(
        project: _studioBook(),
        repo: FakeBookNotesRepository(),
        visited: visited,
        studio: _studio(),
      ),
    );
    await tester.pumpAndSettle();

    // Beneath the manuscript's own card, and quieter than it.
    expect(find.text('Continue writing'), findsOneWidget);
    expect(find.text('Add a note'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Add a note')).dy,
      greaterThan(tester.getTopLeft(find.text('Continue writing')).dy),
    );
    expect(
      find.ancestor(
        of: find.text('Add a note'),
        matching: find.byType(FilledButton),
      ),
      findsNothing,
    );

    await tester.tap(find.text('Add a note'));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/notes/new');
  });

  testWidgets('a book still being planned has notes too', (tester) async {
    await _tall(tester);
    await tester.pumpWidget(
      _page(
        project: bookProject(status: 'planning', withPlan: false),
        repo: FakeBookNotesRepository(notes: [fakeNote('a', title: 'Idea')]),
        visited: [],
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Notes · 1'), findsOneWidget);
    expect(find.text('Idea'), findsOneWidget);
  });

  testWidgets('a failed load leaves a door to the list, not an error', (
    tester,
  ) async {
    await _tall(tester);
    final visited = <String>[];
    final repo = FakeBookNotesRepository()
      ..listError = FakeBookNotesRepository.networkError;
    await tester.pumpWidget(
      _page(project: bookProject(), repo: repo, visited: visited),
    );
    await tester.pumpAndSettle();

    expect(find.text('Notes'), findsOneWidget);
    expect(find.text('Add a note'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('book-notes-open')));
    await tester.pumpAndSettle();
    expect(visited.last, '/projects/project-1/notes');
  });
}
