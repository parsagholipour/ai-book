import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/start_writing_sheet.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../support/fake_studio_repository.dart';

// The "Write your own book" sheet every quiet door opens.

class _Harness {
  final visited = <String>[];
  var listFetches = 0;
}

Widget _app(FakeStudioRepository studio, _Harness harness) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: Consumer(
            builder: (context, ref, _) {
              // Watched, so an invalidation re-fetches the list.
              ref.watch(projectsProvider);
              return Center(
                child: TextButton(
                  onPressed: () => showStartWritingSheet(context),
                  child: const Text('Open'),
                ),
              );
            },
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/write',
        builder: (context, state) {
          harness.visited.add(state.uri.toString());
          return const Scaffold(body: Text('studio'));
        },
      ),
      GoRoute(
        path: '/books/import',
        builder: (context, state) {
          harness.visited.add(state.uri.toString());
          return const Scaffold(body: Text('import'));
        },
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      studioRepositoryProvider.overrideWithValue(studio),
      projectsProvider.overrideWith((ref) async {
        harness.listFetches += 1;
        return const <MobileProjectSummary>[];
      }),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: router,
    ),
  );
}

Future<void> _open(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('offers the four kinds, a story by default', (tester) async {
    await tester.pumpWidget(_app(FakeStudioRepository(), _Harness()));
    await tester.pumpAndSettle();
    await _open(tester);

    expect(find.text('Write your own book'), findsOneWidget);
    for (final kind in ManuscriptKind.values) {
      expect(find.text(kind.label), findsOneWidget);
    }
    expect(
      find.text('A picture on every page, with a few lines of text.'),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(
        find.byKey(const ValueKey('start-writing-kind-story')),
      ),
      isSemantics(isSelected: true),
    );
    expect(
      tester.getSemantics(
        find.byKey(const ValueKey('start-writing-kind-picture')),
      ),
      isSemantics(isSelected: false),
    );
  });

  testWidgets('Start writing creates the book and opens its first chapter', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'p9');
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    expect(harness.listFetches, 1);
    await _open(tester);

    final picture = find.byKey(const ValueKey('start-writing-kind-picture'));
    await tester.ensureVisible(picture);
    await tester.pumpAndSettle();
    await tester.tap(picture);
    await tester.enterText(
      find.byKey(const ValueKey('start-writing-title')),
      '  The Moon Boat ',
    );
    await tester.tap(find.byKey(const ValueKey('start-writing-button')));
    await tester.pumpAndSettle();

    final request = studio.createRequests.single;
    expect(request.kind, ManuscriptKind.picture);
    expect(request.title, 'The Moon Boat');
    expect(harness.visited, ['/projects/p9/write?chapter=c1']);
    expect(find.text('Write your own book'), findsNothing);
    // The new book is on the shelf the moment the author comes back.
    expect(harness.listFetches, 2);
  });

  testWidgets('a blank title is left for the server to name', (tester) async {
    final studio = FakeStudioRepository();
    await tester.pumpWidget(_app(studio, _Harness()));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('start-writing-button')));
    await tester.pumpAndSettle();

    expect(studio.createRequests.single.title, isNull);
    expect(studio.createRequests.single.kind, ManuscriptKind.story);
  });

  testWidgets('a failed start says why and retries as the same request', (
    tester,
  ) async {
    final studio = FakeStudioRepository()
      ..createError = const ApiException(
        code: 'SERVER_ERROR',
        message: 'The server is having a moment.',
        statusCode: 503,
      );
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('start-writing-button')));
    await tester.pumpAndSettle();

    expect(find.text('Could not start your book'), findsOneWidget);
    expect(find.text('The server is having a moment.'), findsOneWidget);
    expect(harness.visited, isEmpty);

    studio.createError = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(studio.createRequests, hasLength(2));
    expect(
      studio.createRequests.last.requestId,
      studio.createRequests.first.requestId,
    );
    expect(harness.visited, ['/projects/p1/write?chapter=c1']);
  });

  testWidgets('Import a manuscript goes to the import screen', (tester) async {
    final harness = _Harness();
    await tester.pumpWidget(_app(FakeStudioRepository(), harness));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('start-writing-import')));
    await tester.pumpAndSettle();

    expect(harness.visited, ['/books/import']);
    expect(find.text('Write your own book'), findsNothing);
  });
}
