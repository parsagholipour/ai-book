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
  @override
  Future<MobileEditableBook> getEditableBook(String projectId) async =>
      const MobileEditableBook(
        projectId: 'project-1',
        title: 'The Lantern Keeper',
        pages: [
          MobileEditableBookPage(
            id: 'p1',
            index: 1,
            title: 'The Lamp',
            markdown: 'Every evening Mara climbed the stairs.',
            revision: 1,
          ),
          MobileEditableBookPage(
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

Widget _app({ProviderContainer? container}) {
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
      projectsRepositoryProvider.overrideWithValue(_BookRepository()),
    ],
    child: app,
  );
}

void main() {
  test('an excerpt is plain text cut at a word', () {
    expect(
      bookEditExcerpt('# Title\n\nBoats came **home** slowly.'),
      'Title Boats came home slowly.',
    );
    final long = bookEditExcerpt('word ' * 60);
    expect(long.length, lessThanOrEqualTo(90));
    expect(long.endsWith('word'), isTrue);
    expect(bookEditExcerpt('![alt](x.png) Just text'), 'Just text');
  });

  test('a request quotes the page rather than numbering it', () {
    expect(
      BookEditAsk.warmer.draft('Boats came home'),
      'Rewrite this passage: "Boats came home". Make it warmer.',
    );
    expect(BookEditAsk.picture.draft(''), 'Add a picture to this page.');
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
      'Rewrite this passage: "Every evening Mara climbed the stairs.". '
      'Make it warmer.',
    );
  });
}
