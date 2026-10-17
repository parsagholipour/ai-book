/// Shared fixtures for the chat drawer's suites: a drawer mounted over fake
/// repositories, chat/project/status builders, and the finders for a row's
/// leading picture. Split out of chat_history_drawer_test.dart when the suite
/// outgrew the file-size budget.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_cover.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';

import 'chat_session_page_fixture.dart';

Widget drawerApp({
  required List<MobileChatSession> sessions,
  required String activeDraftId,
  List<MobileProjectSummary> projects = const [],
  Stream<MobileProjectStatus>? statuses,
  CreationRepository? repository,
}) {
  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(
        repository ?? FakeCreationRepository(sessions),
      ),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      projectsProvider.overrideWith((ref) async => projects),
      projectStatusProvider.overrideWith(
        (ref, id) => statuses ?? const Stream<MobileProjectStatus>.empty(),
      ),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Scaffold(body: ChatHistoryDrawer(activeDraftId: activeDraftId)),
    ),
  );
}

Future<void> openChatSearch(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Search chats'));
  await tester.pumpAndSettle();
}

/// Timed pumps rather than `pumpAndSettle`: an indeterminate spinner animates
/// forever, so a drawer with a busy chat in it never settles.
Future<void> pumpDrawer(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// The indeterminate spinner only: a status chip's determinate progress ring
/// is a reading, not work in flight.
Finder spinnerIn(String title) {
  return find.descendant(
    of: find.widgetWithText(ListTile, title),
    matching: find.byWidgetPredicate(
      (widget) => widget is CircularProgressIndicator && widget.value == null,
    ),
  );
}

Finder coverIn(String title) {
  return find.descendant(
    of: find.widgetWithText(ListTile, title),
    matching: find.byType(BookCover),
  );
}

Finder glyphIn(String title) {
  return find.descendant(
    of: find.widgetWithText(ListTile, title),
    matching: find.byIcon(Icons.chat_bubble_outline),
  );
}

MobileChatSession chatSession({
  required String draftId,
  required String title,
  DateTime? lastMessageAt,
  String? activeProjectId,
  String preview = 'Latest message',
}) {
  final now = DateTime.utc(2026, 6, 15);
  return MobileChatSession(
    draftId: draftId,
    title: title,
    preview: preview,
    messageCount: 2,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: lastMessageAt,
    activeProjectId: activeProjectId,
  );
}

MobileProjectSummary drawerProject({
  required String id,
  required String status,
  bool ready = false,
}) {
  return MobileProjectSummary(
    id: id,
    title: 'A book',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    status: status,
    statusLabel: status,
    progressPercent: 40,
    currentAction: status,
    promptPreview: 'A practical workbook.',
    targetPages: 18,
    pageCount: 6,
    imageCount: 0,
    hasPlan: true,
    exports: ready ? drawerReadyExports : drawerExports,
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: DateTime.utc(2026, 6, 1),
  );
}

MobileProjectStatus drawerStatus({required String id, required String status}) {
  return MobileProjectStatus(
    projectId: id,
    status: status,
    statusLabel: status,
    progressPercent: 100,
    currentAction: status,
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 6, target: 6),
    imageCount: 0,
    exports: drawerExports,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

const drawerReadyExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    downloadUrl: '/api/mobile/projects/book-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    downloadUrl: '/api/mobile/projects/book-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

const drawerExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    downloadUrl: '/api/mobile/projects/book-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    downloadUrl: '/api/mobile/projects/book-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

class FakeCreationRepository
    with ListSessionsPageFromList
    implements CreationRepository {
  const FakeCreationRepository(this.sessions);

  final List<MobileChatSession> sessions;

  @override
  Future<List<MobileChatSession>> listSessions() async => sessions;

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class ThrowingCreationRepository
    with ListSessionsPageFromList
    implements CreationRepository {
  @override
  Future<List<MobileChatSession>> listSessions() async {
    throw Exception('network down');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => drawerBilling();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileBilling drawerBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 1200,
      reserved: 0,
      lifetimeGranted: 1200,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [],
    creditCosts: {
      'fullBookBase': 250,
      'fullBookPerPage': 8,
      'imageGeneration': 70,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

class SparseSearchRepository extends FakeCreationRepository {
  SparseSearchRepository({this.firstPage, this.tail}) : super(const []);

  final List<MobileChatSession>? firstPage;
  final Completer<MobileChatSessionPage>? tail;

  @override
  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  }) async {
    if (query.isEmpty) {
      return const MobileChatSessionPage(sessions: []);
    }
    if (cursor == null) {
      return MobileChatSessionPage(
        sessions: firstPage ?? const [],
        nextCursor: 'more',
      );
    }
    if (tail != null) return tail!.future;
    throw Exception('offline');
  }
}

class RetryingPageRepository extends FakeCreationRepository {
  RetryingPageRepository(super.sessions);
  bool fail = true;
  int tailCalls = 0;

  @override
  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  }) async {
    if (cursor != null) {
      tailCalls++;
      if (fail) throw Exception('offline');
    }
    return super.listSessionsPage(cursor: cursor, query: query);
  }
}
