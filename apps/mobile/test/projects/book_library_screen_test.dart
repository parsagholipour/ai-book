import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/book_library.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_library_card.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';

import 'book_shelf_test.dart' show billingWith, shelfExports;

void main() {
  testWidgets(
    'search matches title, subtitle, author and topic without case sensitivity',
    (tester) async {
      await tester.pumpWidget(_app(_Repository(_books)));
      await tester.pumpAndSettle();

      expect(_visibleIds(tester), ['ocean', 'garden', 'stars']);
      expect(find.text('3 books'), findsOneWidget);

      for (final query in [
        '  OCEAN  ',
        'blue planet',
        'maya',
        'marine wildlife',
        'MAYA ocean',
      ]) {
        await tester.enterText(find.byType(TextField), query);
        await tester.pumpAndSettle();
        expect(_visibleIds(tester), ['ocean'], reason: query);
        expect(find.text('1 of 3 books'), findsOneWidget);
      }

      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['ocean', 'garden', 'stars']);
    },
  );

  testWidgets(
    'status filters combine with search and empty results can be reset',
    (tester) async {
      await tester.pumpWidget(_app(_Repository(_books)));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(ChoiceChip, 'Ready to read'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['garden']);

      await tester.tap(find.widgetWithText(ChoiceChip, 'In progress'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['ocean']);

      await tester.tap(find.widgetWithText(ChoiceChip, 'Needs attention'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['stars']);

      await tester.enterText(find.byType(TextField), 'ocean');
      await tester.pumpAndSettle();
      expect(find.text('No matching books'), findsOneWidget);
      expect(find.text('0 of 3 books'), findsOneWidget);
      await tester.tap(find.text('Reset search and filters'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['ocean', 'garden', 'stars']);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '',
      );
    },
  );

  testWidgets(
    'sorting supports title, creation date and most recent activity',
    (tester) async {
      await tester.pumpWidget(_app(_Repository(_books)));
      await tester.pumpAndSettle();

      for (final entry in {
        'Title A–Z': ['garden', 'ocean', 'stars'],
        'Newest first': ['stars', 'garden', 'ocean'],
        'Recently updated': ['ocean', 'garden', 'stars'],
      }.entries) {
        await tester.tap(find.byTooltip('Sort books'));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byWidgetPredicate(
            (widget) =>
                widget is CheckedPopupMenuItem<BookLibrarySort> &&
                widget.value?.label == entry.key,
          ),
        );
        await tester.pumpAndSettle();
        expect(_visibleIds(tester), entry.value);
      }
    },
  );

  testWidgets(
    'books open the reader or progress and Back preserves the search',
    (tester) async {
      await tester.pumpWidget(_app(_Repository(_books)));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'garden');
      await tester.pumpAndSettle();
      await tester.tap(find.byType(BookLibraryCard));
      await tester.pumpAndSettle();
      expect(find.text('Reader: garden'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['garden']);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'garden',
      );

      await tester.enterText(find.byType(TextField), 'ocean');
      await tester.pumpAndSettle();
      await tester.tap(find.byType(BookLibraryCard));
      await tester.pumpAndSettle();
      expect(find.text('Progress: ocean'), findsOneWidget);
    },
  );

  testWidgets('book options offer chat and the existing export actions', (
    tester,
  ) async {
    await tester.pumpWidget(_app(_Repository(_books)));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Options for Garden Notes'));
    await tester.pumpAndSettle();

    expect(find.text('Go to chat'), findsOneWidget);
    expect(find.text('Open PDF'), findsOneWidget);
    expect(find.text('Share PDF'), findsOneWidget);
  });

  testWidgets(
    'an empty library explains where books appear and offers creation',
    (tester) async {
      await tester.pumpWidget(
        _app(_Repository([_book(id: 'idea', title: 'An idea', pages: 0)])),
      );
      await tester.pumpAndSettle();
      expect(find.text('No books yet'), findsOneWidget);
      expect(find.byType(BookLibraryCard), findsNothing);
      await tester.tap(find.text('New book'));
      await tester.pumpAndSettle();
      expect(find.text('New book chat'), findsOneWidget);
    },
  );

  testWidgets(
    'loading and failure stay distinct from empty and retry recovers',
    (tester) async {
      final request = Completer<List<MobileProjectSummary>>();
      final repository = _Repository(_books)..pending = request.future;
      await tester.pumpWidget(_app(repository));
      expect(find.text('Loading your books'), findsOneWidget);
      expect(find.text('No books yet'), findsNothing);

      request.completeError(Exception('offline'));
      await tester.pumpAndSettle();
      expect(find.text('Could not load your books'), findsOneWidget);
      repository.pending = null;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(_visibleIds(tester), ['ocean', 'garden', 'stars']);
    },
  );

  testWidgets('pull to refresh loads newly created books', (tester) async {
    final repository = _Repository([_books[1]]);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();
    repository.books = _books;
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(_visibleIds(tester), ['ocean', 'garden', 'stars']);
  });

  testWidgets(
    'live books refresh without losing search and stop polling when settled',
    (tester) async {
      final repository = _Repository(_books);
      await tester.pumpWidget(_app(repository));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'ocean');
      await tester.pumpAndSettle();

      repository.books = [
        _book(id: 'ocean', title: 'Ocean Atlas', ready: true),
      ];
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      final card = tester.widget<BookLibraryCard>(find.byType(BookLibraryCard));
      expect(card.book.exports.pdf.available, isTrue);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'ocean',
      );
      final calls = repository.calls;
      await tester.pump(const Duration(seconds: 12));
      expect(repository.calls, calls);
    },
  );

  testWidgets('the library stays usable at narrow widths and larger text', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_app(_Repository(_books), textScale: 1.8));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(find.byType(TextField), 'ocean');
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byType(BookLibraryCard));
    expect(_visibleIds(tester), ['ocean']);
    expect(tester.takeException(), isNull);
  });
}

List<String> _visibleIds(WidgetTester tester) => tester
    .widgetList<BookLibraryCard>(find.byType(BookLibraryCard))
    .map((card) => card.book.id)
    .toList();

Widget _app(_Repository repository, {double textScale = 1}) {
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith((ref) async => billingWith(900)),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      routerConfig: GoRouter(
        initialLocation: '/books',
        routes: [
          GoRoute(path: '/books', builder: (_, _) => const BookLibraryScreen()),
          GoRoute(
            path: '/books/new',
            builder: (_, _) =>
                Scaffold(appBar: AppBar(), body: const Text('New book chat')),
          ),
          GoRoute(
            path: '/projects/:id',
            builder: (_, state) => Scaffold(
              appBar: AppBar(),
              body: Text('Progress: ${state.pathParameters['id']}'),
            ),
          ),
          GoRoute(
            path: '/projects/:id/read',
            builder: (_, state) => Scaffold(
              appBar: AppBar(),
              body: Text('Reader: ${state.pathParameters['id']}'),
            ),
          ),
        ],
      ),
    ),
  );
}

final _books = [
  _book(id: 'stars', title: 'Stargazing', status: 'failed', createdDay: 3),
  _book(
    id: 'garden',
    title: 'Garden Notes',
    ready: true,
    updatedDay: 2,
    createdDay: 2,
  ),
  _book(
    id: 'ocean',
    title: 'Ocean Atlas',
    subtitle: 'Our blue planet',
    author: 'Maya Chen',
    topic: 'Marine wildlife',
    status: 'generating',
    updatedDay: 3,
  ),
  _book(id: 'idea', title: 'Just an idea', pages: 0),
];

MobileProjectSummary _book({
  required String id,
  required String title,
  String? subtitle,
  String? author,
  String topic = '',
  String status = 'paused',
  bool ready = false,
  int pages = 12,
  int updatedDay = 1,
  int createdDay = 1,
}) => MobileProjectSummary(
  id: id,
  title: title,
  subtitle: subtitle,
  authorName: author,
  bookType: 'workbook',
  lengthPreset: 'standard',
  qualityPreset: 'balanced',
  status: ready ? 'complete' : status,
  statusLabel: status == 'generating' ? 'Writing your book' : status,
  progressPercent: ready ? 100 : 50,
  currentAction: '',
  promptPreview: topic,
  targetPages: 24,
  pageCount: pages,
  imageCount: 0,
  hasPlan: pages > 0,
  exports: shelfExports(ready: ready),
  createdAt: DateTime.utc(2026, 6, createdDay),
  updatedAt: DateTime.utc(2026, 7, updatedDay),
);

class _Repository implements ProjectsRepository {
  _Repository(this.books);
  List<MobileProjectSummary> books;
  Future<List<MobileProjectSummary>>? pending;
  int calls = 0;

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    calls++;
    return pending ?? Future.value(books);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
