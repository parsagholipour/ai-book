import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/offline_library_store.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_library_card.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/ui/motion.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';

import 'book_shelf_test.dart' show billingWith;
import 'offline_library_test.dart' show summaryJson;

// With no connection the library used to be "Could not load your books", so
// a reader on a plane could not reach a single book already on their phone.

class _Repository implements ProjectsRepository {
  Object? error = const ApiException(
    code: 'NETWORK_ERROR',
    message: 'Check your connection and try again.',
  );

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    final failure = error;
    if (failure != null) throw failure;
    return [
      MobileProjectSummary.fromJson(summaryJson('ready')),
      MobileProjectSummary.fromJson(
        summaryJson(
          'running',
          title: 'Still going',
          status: 'generating',
          pdf: false,
        ),
      ),
    ];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _app(_Repository repository, OfflineLibraryStore store) {
  return ProviderScope(
    retry: (_, _) => null,
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      offlineLibraryStoreProvider.overrideWithValue(store),
      billingProvider.overrideWith((ref) async => billingWith(900)),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: GoRouter(
        initialLocation: '/books',
        routes: [
          GoRoute(path: '/books', builder: (_, _) => const BookLibraryScreen()),
          GoRoute(
            path: '/projects/:id/read',
            builder: (_, state) => Scaffold(
              appBar: AppBar(),
              body: Text('Reading ${state.pathParameters['id']}'),
            ),
          ),
          GoRoute(
            path: '/projects/:id',
            builder: (_, state) => Scaffold(
              appBar: AppBar(),
              body: Text('Book ${state.pathParameters['id']}'),
            ),
          ),
        ],
      ),
    ),
  );
}

Finder _card(String title) => find
    .ancestor(of: find.text(title), matching: find.byType(BookLibraryCard))
    .first;

void main() {
  late MemoryOfflineLibraryStore store;

  setUp(() {
    store = MemoryOfflineLibraryStore(
      library: OfflineLibrary(
        savedAt: DateTime(2026, 10, 12, 9, 30),
        books: [
          MobileProjectSummary.fromJson(summaryJson('ready')),
          MobileProjectSummary.fromJson(
            summaryJson(
              'running',
              title: 'Still going',
              status: 'generating',
              pdf: false,
            ),
          ),
        ],
      ),
    );
  });

  testWidgets('offline, the library is the phone\'s copy and says so', (
    tester,
  ) async {
    await tester.pumpWidget(_app(_Repository(), store));
    await tester.pumpAndSettle();

    expect(find.text('Could not load your books'), findsNothing);
    expect(find.text("You're offline"), findsOneWidget);
    expect(find.textContaining('Showing your books as of'), findsOneWidget);
    expect(_card('The Race'), findsOneWidget);

    // A book that was being written is a memory, not progress happening now.
    expect(
      find.descendant(
        of: _card('Still going'),
        matching: find.text('Last seen being written'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _card('Still going'),
        matching: find.byType(AppAnimatedProgressBar),
      ),
      findsNothing,
    );
    expect(find.textContaining('45%'), findsNothing);

    // A downloaded book still opens straight into the reader.
    await tester.tap(_card('The Race'));
    await tester.pumpAndSettle();
    expect(find.text('Reading ready'), findsOneWidget);
  });

  testWidgets('back online, the server\'s list replaces the copy', (
    tester,
  ) async {
    final repository = _Repository();
    await tester.pumpWidget(_app(repository, store));
    await tester.pumpAndSettle();
    expect(find.text("You're offline"), findsOneWidget);

    repository.error = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(find.text("You're offline"), findsNothing);
    expect(find.text('Last seen being written'), findsNothing);
    expect(
      find.descendant(
        of: _card('Still going'),
        matching: find.byType(AppAnimatedProgressBar),
      ),
      findsOneWidget,
    );
    expect(store.library?.books, hasLength(2));
  });
}
