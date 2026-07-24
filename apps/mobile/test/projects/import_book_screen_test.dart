import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/import_book_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

void main() {
  testWidgets('imports a manuscript and navigates to the handoff screen', (
    tester,
  ) async {
    final repository = _FakeProjectsRepository();
    await tester.pumpWidget(
      _routerApp(
        repository: repository,
        pickedFile: XFile.fromData(
          Uint8List.fromList('Chapter 1\n\nOnce upon a time.'.codeUnits),
          name: 'novel.txt',
          path: 'novel.txt',
        ),
      ),
    );
    await tester.pumpAndSettle();

    // No file picked yet: submit stays disabled.
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('import-submit')),
          )
          .onPressed,
      isNull,
    );

    await tester.tap(find.byKey(const ValueKey('import-pick-file')));
    await tester.pumpAndSettle();
    expect(find.text('novel.txt'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('import-submit')));
    await tester.pumpAndSettle();

    expect(repository.importedFilenames, ['novel.txt']);
    expect(repository.requestIds.single, isNotEmpty);
    expect(find.text('handoff-screen'), findsOneWidget);
  });

  testWidgets('shows the paywall when the account has no subscription', (
    tester,
  ) async {
    final repository = _FakeProjectsRepository(
      error: const ApiException(
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'Importing your own book is part of the Creator plan.',
        statusCode: 403,
      ),
    );
    await tester.pumpWidget(
      _routerApp(
        repository: repository,
        pickedFile: XFile.fromData(
          Uint8List.fromList('Chapter 1\n\nOnce.'.codeUnits),
          name: 'novel.txt',
          path: 'novel.txt',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('import-pick-file')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('import-submit')));
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(find.text('handoff-screen'), findsNothing);
  });

  testWidgets('blocks oversized manuscripts before any upload', (tester) async {
    final repository = _FakeProjectsRepository();
    await tester.pumpWidget(
      _routerApp(
        repository: repository,
        pickedFile: XFile.fromData(
          Uint8List(21 * 1024 * 1024),
          name: 'giant.txt',
          path: 'giant.txt',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('import-pick-file')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('import-error')), findsOneWidget);
    expect(find.textContaining('20 MB'), findsWidgets);
    expect(repository.importedFilenames, isEmpty);
  });

  testWidgets('surfaces server rejections inline', (tester) async {
    final repository = _FakeProjectsRepository(
      error: const ApiException(
        code: 'UNREADABLE_FILE',
        message: 'No readable text was found in that file.',
        statusCode: 422,
      ),
    );
    await tester.pumpWidget(
      _routerApp(
        repository: repository,
        pickedFile: XFile.fromData(
          Uint8List.fromList('x'.codeUnits),
          name: 'novel.docx',
          path: 'novel.docx',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('import-pick-file')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('import-submit')));
    await tester.pumpAndSettle();

    expect(find.text('No readable text was found in that file.'), findsOneWidget);
    expect(find.text('handoff-screen'), findsNothing);
  });
}

Widget _routerApp({
  required _FakeProjectsRepository repository,
  required XFile pickedFile,
}) {
  final router = GoRouter(
    initialLocation: '/books/import',
    routes: [
      GoRoute(
        path: '/books/import',
        builder: (context, state) =>
            ImportBookScreen(pickFileOverride: () async => pickedFile),
      ),
      GoRoute(
        path: '/projects/:id/handoff',
        builder: (context, state) =>
            const Scaffold(body: Text('handoff-screen')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

class _FakeProjectsRepository implements ProjectsRepository {
  _FakeProjectsRepository({this.error});

  final ApiException? error;
  final importedFilenames = <String>[];
  final requestIds = <String>[];

  @override
  Future<MobileImportedBook> importBook({
    required List<int> bytes,
    required String filename,
    required String requestId,
    String? mimeType,
    String? title,
    String? language,
    void Function(int sent, int total)? onProgress,
  }) async {
    final failure = error;
    if (failure != null) {
      throw failure;
    }
    importedFilenames.add(filename);
    requestIds.add(requestId);
    return MobileImportedBook(
      project: _importedProject(),
      importId: 'imp_1',
      importStatus: 'UPLOADED',
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async {
    return const MobileBilling(
      credits: CreditBalance(
        available: 0,
        reserved: 0,
        lifetimeGranted: 0,
        lifetimeSpent: 0,
      ),
      entitlements: [],
      products: [],
      creditCosts: {},
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectDetail _importedProject() {
  return MobileProjectDetail(
    id: 'project-imported',
    title: 'Novel',
    bookType: 'custom',
    lengthPreset: 'custom',
    qualityPreset: 'balanced',
    imagesEnabled: false,
    status: 'generating',
    statusLabel: 'Importing your book',
    progressPercent: 5,
    currentAction: 'Importing your book.',
    promptPreview: 'Imported manuscript: Novel.',
    targetPages: 12,
    pageCount: 0,
    imageCount: 0,
    hasPlan: false,
    exports: const MobileExportSet(
      pdf: MobileExportAvailability(
        format: 'pdf',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '',
        filename: '',
        contentType: 'application/pdf',
      ),
      epub: MobileExportAvailability(
        format: 'epub',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '',
        filename: '',
        contentType: 'application/epub+zip',
      ),
    ),
    createdAt: DateTime.utc(2026, 7, 24),
    updatedAt: DateTime.utc(2026, 7, 24),
    source: 'imported',
    prompt: 'Imported manuscript: Novel.',
    language: 'en',
    pages: const [],
  );
}
