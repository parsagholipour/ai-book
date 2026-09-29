import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_actions.dart';

import '../../projects/book_page_fixtures.dart';

// The reader's "Edit page" for a book the author owns opens the Writing
// Studio at the page's chapter; every other book keeps Edit Mode.

class _LocatorRepository implements ReaderRepository {
  final revisions = <int>[];

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) async {
    revisions.add(revision);
    return ReaderPageLocator(
      const MobileEditableBook(
        projectId: 'project-1',
        title: 'The Book',
        pages: [
          MobileEditableBookPage(
            id: 'page-1',
            index: 1,
            title: 'The bottle · 1',
            markdown: 'She found it at dawn.',
            revision: 1,
            chapterId: 'ch-1',
          ),
          MobileEditableBookPage(
            id: 'page-2',
            index: 2,
            title: 'The answer · 1',
            markdown: 'She wrote back.',
            revision: 1,
            chapterId: 'ch-2',
          ),
        ],
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

const _selection = ReaderSelection(
  text: 'She wrote back.',
  pdfPageNumber: 3,
  bookPageIndex: 2,
  placed: true,
);

/// Runs Edit page from a button inside a router, recording where it went.
Widget _router({
  required List<String> visited,
  required ReaderStudioRoute? Function(WidgetRef ref) studioRoute,
  List<MobileProjectSummary> projects = const [],
}) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () => runReaderSelectionAction(
                context: context,
                projectId: 'project-1',
                selection: _selection,
                action: ReaderSelectionAction.editPage,
                studioRoute: studioRoute(ref),
              ),
              child: const Text('Edit page'),
            ),
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/:page',
        builder: (context, state) {
          visited.add(state.uri.toString());
          return const Scaffold(body: Text('elsewhere'));
        },
      ),
    ],
  );
  return ProviderScope(
    overrides: [projectsProvider.overrideWith((ref) async => projects)],
    child: MaterialApp.router(routerConfig: router),
  );
}

void main() {
  test('the editable page carries its chapter, when the server sends one', () {
    final page = MobileEditableBookPage.fromJson(const {
      'id': 'page-1',
      'index': 1,
      'title': 'One',
      'markdown': 'Text.',
      'revision': 3,
      'chapterId': 'ch-9',
    });
    expect(page.chapterId, 'ch-9');
    final older = MobileEditableBookPage.fromJson(const {
      'id': 'page-1',
      'index': 1,
      'title': 'One',
      'markdown': 'Text.',
      'revision': 3,
    });
    expect(older.chapterId, isNull);
    expect(older.revision, 3);
  });

  testWidgets('an author book opens the Studio at the page\'s chapter', (
    tester,
  ) async {
    final visited = <String>[];
    final repository = _LocatorRepository();
    await tester.pumpWidget(
      _router(
        visited: visited,
        projects: [bookProject(source: 'imported')],
        studioRoute: (ref) => readerStudioRoute(
          ref: ref,
          repository: repository,
          projectId: 'project-1',
          revision: () => 7,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit page'));
    await tester.pumpAndSettle();

    expect(visited, ['/projects/project-1/write?chapter=ch-2']);
    expect(repository.revisions, [7]);
  });

  testWidgets('without a mapped revision the Studio opens where it was', (
    tester,
  ) async {
    final visited = <String>[];
    final repository = _LocatorRepository();
    await tester.pumpWidget(
      _router(
        visited: visited,
        projects: [bookProject(source: 'written')],
        studioRoute: (ref) => readerStudioRoute(
          ref: ref,
          repository: repository,
          projectId: 'project-1',
          revision: () => null,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit page'));
    await tester.pumpAndSettle();

    expect(visited, ['/projects/project-1/write']);
    expect(repository.revisions, isEmpty);
  });

  testWidgets('a generated book keeps Edit Mode at the page', (tester) async {
    final visited = <String>[];
    final repository = _LocatorRepository();
    await tester.pumpWidget(
      _router(
        visited: visited,
        projects: [bookProject()],
        studioRoute: (ref) => readerStudioRoute(
          ref: ref,
          repository: repository,
          projectId: 'project-1',
          revision: () => 7,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit page'));
    await tester.pumpAndSettle();

    expect(visited, ['/projects/project-1/edit?pageIndex=2']);
    expect(repository.revisions, isEmpty);
  });

  testWidgets('with no Studio lookup at all, Edit Mode as before', (
    tester,
  ) async {
    final visited = <String>[];
    await tester.pumpWidget(
      _router(visited: visited, studioRoute: (ref) => null),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Edit page'));
    await tester.pumpAndSettle();

    expect(visited, ['/projects/project-1/edit?pageIndex=2']);
  });
}
