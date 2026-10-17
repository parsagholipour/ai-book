import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_edit_screen.dart';
import 'package:tomeza/features/projects/presentation/book_edit_widgets.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

import 'book_page_fixtures.dart';

class _BookRepository implements ProjectsRepository {
  _BookRepository({
    this.firstPageMarkdown = 'Every evening Mara climbed the stairs.',
  });

  final String firstPageMarkdown;

  @override
  Future<MobileEditableBook> getEditableBook(String projectId) async =>
      MobileEditableBook(
        projectId: 'project-1',
        title: 'The Lantern Keeper',
        pages: [
          MobileEditableBookPage(
            id: 'p1',
            index: 1,
            title: 'The Lamp',
            markdown: firstPageMarkdown,
            revision: 1,
          ),
          const MobileEditableBookPage(
            id: 'p2',
            index: 2,
            title: 'The Harbour',
            markdown: '# The Harbour\n\nBoats came home **slowly** at dusk.',
            revision: 1,
          ),
        ],
      );

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not used in this test.');
}

Object? launchExtra;

Widget _app({
  ProviderContainer? container,
  ProjectsRepository? repository,
  Future<MobileProjectDetail> Function()? loadProject,
}) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const BookEditScreen(projectId: 'project-1'),
      ),
      GoRoute(
        path: '/projects/:id/chat',
        builder: (_, state) {
          launchExtra = state.extra;
          return const Scaffold(body: Text('chat opened'));
        },
      ),
    ],
  );
  final app = MaterialApp.router(routerConfig: router);
  if (container != null) {
    return UncontrolledProviderScope(container: container, child: app);
  }
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(
        repository ?? _BookRepository(),
      ),
      projectDetailProvider('project-1').overrideWith(
        (ref) => loadProject?.call() ?? Future.value(bookProject()),
      ),
    ],
    child: app,
  );
}

void main() {
  test('a request quotes the page rather than numbering it', () {
    expect(
      BookEditAsk.warmer.draft('Boats came home'),
      'Rewrite this page: "Boats came home". Make it warmer.',
    );
    expect(
      BookEditAsk.warmer.draft('Boats came home', isSelection: true),
      'Rewrite this passage: "Boats came home". Make it warmer.',
    );
    expect(BookEditAsk.picture.draft(''), 'Add a picture to this page.');
    expect(
      BookEditAsk.simpler.draft(''),
      'Simplify this page while keeping the meaning.',
    );
  });

  for (final category in [
    (type: 'short_story', shape: 'book', story: true),
    (type: 'custom', shape: 'story', story: true),
    (type: 'custom', shape: 'children_story', story: true),
    (type: 'custom', shape: 'book', story: false),
    (type: 'custom', shape: 'workbook', story: false),
    (type: 'custom', shape: 'guide', story: false),
    (type: 'workbook', shape: 'book', story: false),
    (type: 'lead_magnet', shape: 'book', story: false),
    (type: 'short_story', shape: 'workbook', story: false),
    (type: 'custom', shape: 'unknown', story: false),
  ]) {
    testWidgets(
      '${category.type}/${category.shape} offers appropriate page edits',
      (tester) async {
        await tester.pumpWidget(
          _app(
            loadProject: () async =>
                bookProject(bookType: category.type, bookShape: category.shape),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text('Make it warmer'),
          category.story ? findsOneWidget : findsNothing,
        );
        expect(
          find.text('Simplify it'),
          category.story ? findsNothing : findsOneWidget,
        );
        expect(find.text('Shorten it'), findsOneWidget);
        expect(find.text('Add a picture'), findsOneWidget);
      },
    );
  }

  testWidgets('suggestions update when the book category finishes loading', (
    tester,
  ) async {
    final project = Completer<MobileProjectDetail>();
    await tester.pumpWidget(_app(loadProject: () => project.future));
    await tester.pumpAndSettle();

    expect(find.text('Simplify it'), findsOneWidget);
    expect(find.text('Make it warmer'), findsNothing);

    project.complete(bookProject(bookType: 'custom', bookShape: 'story'));
    await tester.pumpAndSettle();

    expect(find.text('Make it warmer'), findsOneWidget);
    expect(find.text('Simplify it'), findsNothing);
  });

  testWidgets('missing book metadata keeps generic page edits usable', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        loadProject: () async => throw Exception('Book metadata unavailable'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Simplify it'), findsOneWidget);
    expect(find.text('Make it warmer'), findsNothing);
    expect(find.text('Shorten it'), findsOneWidget);
    expect(find.text('Add a picture'), findsOneWidget);
  });

  testWidgets('shows the review notes that sent the reader here', (
    tester,
  ) async {
    // The book page's "Review" opens Edit Mode at the first flagged page; the
    // page used to open with nothing on it saying why.
    final container = ProviderContainer(
      overrides: [
        projectsRepositoryProvider.overrideWithValue(_BookRepository()),
        projectDetailProvider('project-1').overrideWith(
          (ref) async => bookProject(
            quality: const MobileProjectQuality(
              state: 'review_recommended',
              affectedPageIndexes: [2],
              issues: [
                MobileProjectQualityIssue(
                  code: 'CHAPTER_SHORT',
                  severity: 'warning',
                  source: 'deterministic',
                  message: 'The harbour chapter runs short.',
                  guidance: 'Develop the arrival at dusk.',
                  affectedPageIndexes: [2],
                ),
                MobileProjectQualityIssue(
                  code: 'BRIEF',
                  severity: 'warning',
                  source: 'model',
                  message: 'The book never names the lighthouse.',
                  guidance: 'Name it once.',
                  affectedPageIndexes: [],
                ),
              ],
            ),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    // What the book page underneath keeps alive.
    container.listen(projectDetailProvider('project-1'), (_, _) {});
    await container.read(projectDetailProvider('project-1').future);

    await tester.pumpWidget(_app(container: container));
    await tester.pumpAndSettle();
    expect(find.text('1 review note on the whole book'), findsOneWidget);
    expect(find.text('The book never names the lighthouse.'), findsNothing);

    await tester.tap(find.text('Page 2'));
    await tester.pumpAndSettle();
    expect(find.text('1 review note on this page'), findsOneWidget);
    expect(find.text('The harbour chapter runs short.'), findsOneWidget);
    expect(find.text('Develop the arrival at dusk.'), findsOneWidget);
  });

  testWidgets('shows every page in a strip and switches between them', (
    tester,
  ) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    expect(find.text('Page 1'), findsOneWidget);
    expect(find.text('Page 2'), findsOneWidget);
    expect(find.text('The Harbour'), findsOneWidget);
    expect(find.text('Page 1 of 2 · 6 words'), findsOneWidget);

    await tester.tap(find.text('Page 2'));
    await tester.pumpAndSettle();
    expect(find.text('Page 2 of 2 · 9 words'), findsOneWidget);
  });

  testWidgets('an edit is marked as unsaved and can be reverted', (
    tester,
  ) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    expect(find.text('Revert page'), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('text-p1')),
      'Every evening Mara climbed the old stairs.',
    );
    await tester.pump();
    expect(find.text('Edit Mode · 1 unsaved'), findsOneWidget);
    expect(find.text('Revert page'), findsOneWidget);

    await tester.tap(find.text('Revert page'));
    await tester.pump();
    expect(find.text('Edit Mode'), findsOneWidget);
    expect(find.text('Revert page'), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('text-p1')))
          .controller!
          .text,
      'Every evening Mara climbed the stairs.',
    );
  });

  testWidgets('a chip hands the open page to the chat as an unsent draft', (
    tester,
  ) async {
    launchExtra = null;
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Make it warmer'));
    await tester.pumpAndSettle();

    expect(find.text('chat opened'), findsOneWidget);
    final launch = launchExtra as ProjectChatLaunch;
    expect(launch.send, isNull);
    expect(
      launch.draft,
      'Rewrite this page: "Every evening Mara climbed the stairs.". '
      'Make it warmer.',
    );
  });

  const opening = 'Every evening Mara climbed the stairs.';
  const closing =
      'She lit the **lamp** for the boats returning to the harbour, '
      'then waited by the window until every sailor had found the way home.';
  const wholePage = '$opening\n\n$closing';

  for (final highlight in [false, true]) {
    testWidgets(
      'a science book simplification quotes the ${highlight ? 'selection' : 'whole page'}',
      (tester) async {
        const first = 'Water freezes at 0 °C at standard atmospheric pressure.';
        const second = 'Its molecules form an ordered crystalline structure.';
        const page = '$first\n\n$second';
        launchExtra = null;
        await tester.pumpWidget(
          _app(
            repository: _BookRepository(firstPageMarkdown: page),
            loadProject: () async => bookProject(
              bookType: 'custom',
              bookShape: 'workbook',
              prompt: 'A science book about water for high school students.',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Make it warmer'), findsNothing);
        if (highlight) {
          await tester.tap(find.byKey(const ValueKey('text-p1')));
          tester.testTextInput.updateEditingValue(
            const TextEditingValue(
              text: page,
              selection: TextSelection(
                baseOffset: first.length + 2,
                extentOffset: page.length,
              ),
            ),
          );
          await tester.pump();
        }
        await tester.tap(find.text('Simplify it'));
        await tester.pumpAndSettle();

        final launch = launchExtra as ProjectChatLaunch;
        expect(launch.send, isNull);
        expect(
          launch.draft,
          highlight
              ? 'Rewrite this passage: "$second". Simplify it while keeping the meaning.'
              : 'Rewrite this page: "$page". Simplify it while keeping the meaning.',
        );
      },
    );
  }

  testWidgets('Make it warmer quotes the whole page without a highlight', (
    tester,
  ) async {
    launchExtra = null;
    await tester.pumpWidget(
      _app(repository: _BookRepository(firstPageMarkdown: wholePage)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Make it warmer'));
    await tester.pumpAndSettle();

    final launch = launchExtra as ProjectChatLaunch;
    expect(launch.send, isNull);
    expect(launch.draft, 'Rewrite this page: "$wholePage". Make it warmer.');
  });

  testWidgets('a caret uses the whole page including unsaved text', (
    tester,
  ) async {
    launchExtra = null;
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('text-p1')), wholePage);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: wholePage,
        selection: TextSelection.collapsed(offset: opening.length + 2),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Make it warmer'));
    await tester.pumpAndSettle();

    final launch = launchExtra as ProjectChatLaunch;
    expect(launch.send, isNull);
    expect(launch.draft, 'Rewrite this page: "$wholePage". Make it warmer.');
  });

  testWidgets('switching pages does not quote the previous page highlight', (
    tester,
  ) async {
    launchExtra = null;
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('text-p1')));
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: opening,
        selection: TextSelection(baseOffset: 14, extentOffset: 18),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Page 2'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Make it warmer'));
    await tester.pumpAndSettle();

    final launch = launchExtra as ProjectChatLaunch;
    expect(
      launch.draft,
      'Rewrite this page: "# The Harbour\n\nBoats came home **slowly** at dusk.". '
      'Make it warmer.',
    );
  });

  for (final backwards in [false, true]) {
    testWidgets(
      'Make it warmer quotes only the full ${backwards ? 'backwards' : 'forwards'} highlight',
      (tester) async {
        launchExtra = null;
        await tester.pumpWidget(
          _app(repository: _BookRepository(firstPageMarkdown: wholePage)),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('text-p1')));
        tester.testTextInput.updateEditingValue(
          TextEditingValue(
            text: wholePage,
            selection: TextSelection(
              baseOffset: backwards ? wholePage.length : opening.length + 2,
              extentOffset: backwards ? opening.length + 2 : wholePage.length,
            ),
          ),
        );
        await tester.pump();

        await tester.tap(find.text('Make it warmer'));
        await tester.pumpAndSettle();

        final launch = launchExtra as ProjectChatLaunch;
        expect(launch.send, isNull);
        expect(
          launch.draft,
          'Rewrite this passage: "$closing". Make it warmer.',
        );
      },
    );
  }
}
