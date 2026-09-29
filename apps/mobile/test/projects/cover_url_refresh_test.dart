import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_cover.dart';
import 'package:tomeza/features/projects/presentation/book_library_card.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/ui/authed_network_image.dart';

import 'book_shelf_test.dart' show billingWith, shelfExports;

// A redrawn cover keeps its server path; the API moves the `?v=` on its URL
// instead. These check that the surfaces showing a cover follow that URL as
// it arrives — no client-side version on top — through the refreshes the
// screens already run.

MobileProjectImage _cover(String version) => MobileProjectImage(
  id: 'cover-$version',
  role: 'cover',
  url: '/api/mobile/projects/project-1/assets/cover-$version?v=$version',
  contentType: 'image/png',
  altText: 'Cover for The Lighthouse Letter',
);

AuthedNetworkImage _coverImage(WidgetTester tester) =>
    tester.widget<AuthedNetworkImage>(
      find
          .descendant(
            of: find.byType(BookCover),
            matching: find.byType(AuthedNetworkImage),
          )
          .first,
    );

void main() {
  test('the API version survives resolution when no client version is set', () {
    final uri = resolveAuthedImageUri(
      apiBaseUrl: Uri.parse('http://localhost:4001'),
      url: '/assets/images/p1/cover.png?v=two',
      cacheBuster: null,
    );
    expect(
      uri.toString(),
      'http://localhost:4001/assets/images/p1/cover.png?v=two',
    );
  });

  testWidgets('the book hero follows a redrawn cover while the book is being '
      'edited, and on the refresh that settles it', (tester) async {
    final status = StreamController<MobileProjectStatus>.broadcast();
    final repository = _BookRepository(() => status.stream)
      ..cover = _cover('one');
    await tester.pumpWidget(_bookApp(repository));
    await tester.pump();
    status.add(_status('editing'));
    await tester.pump();
    await tester.pump();

    expect(_coverImage(tester).url, _cover('one').url);
    expect(_coverImage(tester).cacheBuster, isNull);

    // The cover job lands mid-edit: the detail poll brings the new URL.
    repository.cover = _cover('two');
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(_coverImage(tester).url, _cover('two').url);

    // And one that lands as the book settles is picked up by the last refresh.
    repository.cover = _cover('three');
    status.add(_status('complete'));
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(_coverImage(tester).url, _cover('three').url);

    await status.close();
  });

  testWidgets('a library tile follows a redrawn cover on the live refresh', (
    tester,
  ) async {
    final repository = _LibraryRepository()..books = [_libraryBook('one')];
    await tester.pumpWidget(_libraryApp(repository));
    await tester.pumpAndSettle();

    expect(_coverImage(tester).url, _cover('one').url);
    expect(_coverImage(tester).cacheBuster, isNull);

    repository.books = [_libraryBook('two')];
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    final card = tester.widget<BookLibraryCard>(find.byType(BookLibraryCard));
    expect(card.book.coverImage?.url, _cover('two').url);
    expect(_coverImage(tester).url, _cover('two').url);
  });
}

final _config = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

List<Override> get _imageOverrides => [
  appConfigProvider.overrideWithValue(_config),
  apiAuthHeadersProvider.overrideWith((ref) async => const <String, String>{}),
];

Widget _bookApp(_BookRepository repository) {
  return ProviderScope(
    overrides: [
      ..._imageOverrides,
      projectsRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith(
        (ref) => Future<MobileBilling>.error(
          UnimplementedError('Billing is not used in this test.'),
        ),
      ),
    ],
    child: const MaterialApp(home: BookScreen(projectId: 'project-1')),
  );
}

Widget _libraryApp(_LibraryRepository repository) {
  return ProviderScope(
    overrides: [
      ..._imageOverrides,
      projectsRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith((ref) async => billingWith(900)),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: GoRouter(
        initialLocation: '/books',
        routes: [
          GoRoute(path: '/books', builder: (_, _) => const BookLibraryScreen()),
        ],
      ),
    ),
  );
}

MobileProjectStatus _status(String status) => MobileProjectStatus(
  projectId: 'project-1',
  status: status,
  statusLabel: status == 'complete' ? 'Ready to read' : 'Applying your edit',
  progressPercent: status == 'complete' ? 100 : 60,
  currentAction: 'Making your cover.',
  retryAvailable: false,
  steps: const [],
  pageProgress: const MobilePageProgress(completed: 10, target: 10),
  imageCount: 0,
  exports: shelfExports(ready: false),
  updatedAt: DateTime.utc(2026, 9, 1),
);

MobileProjectSummary _libraryBook(String version) => MobileProjectSummary(
  id: 'project-1',
  title: 'The Lighthouse Letter',
  bookType: 'short_story',
  lengthPreset: 'standard',
  qualityPreset: 'balanced',
  // Live, so the library keeps refreshing while the cover is redrawn.
  status: 'editing',
  statusLabel: 'Applying your edit',
  progressPercent: 60,
  currentAction: '',
  promptPreview: '',
  targetPages: 10,
  pageCount: 10,
  imageCount: 0,
  hasPlan: true,
  exports: shelfExports(ready: false),
  coverImage: _cover(version),
  createdAt: DateTime.utc(2026, 9, 1),
  updatedAt: DateTime.utc(2026, 9, 1),
);

class _BookRepository implements ProjectsRepository {
  _BookRepository(this.statusStream);

  final Stream<MobileProjectStatus> Function() statusStream;
  MobileProjectImage? cover;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) => statusStream();

  @override
  Future<MobileProjectDetail> getProject(String id) async =>
      MobileProjectDetail(
        id: 'project-1',
        title: 'The Lighthouse Letter',
        bookType: 'short_story',
        lengthPreset: 'standard',
        qualityPreset: 'balanced',
        imagesEnabled: true,
        status: 'editing',
        statusLabel: 'Applying your edit',
        progressPercent: 60,
        currentAction: 'Making your cover.',
        promptPreview: 'A letter in a bottle.',
        targetPages: 10,
        pageCount: 10,
        imageCount: 0,
        hasPlan: true,
        exports: shelfExports(ready: false),
        coverImage: cover,
        createdAt: DateTime.utc(2026, 9, 1),
        updatedAt: DateTime.utc(2026, 9, 1),
        prompt: 'A letter in a bottle.',
        language: 'en',
        pages: const [],
      );

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _LibraryRepository implements ProjectsRepository {
  List<MobileProjectSummary> books = const [];

  @override
  Future<List<MobileProjectSummary>> listProjects() async => books;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
