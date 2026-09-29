import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_edit_screen.dart';
import 'package:tomeza/features/projects/presentation/book_edit_widgets.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

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

Widget _app() {
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
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(_BookRepository()),
    ],
    child: MaterialApp.router(routerConfig: router),
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
