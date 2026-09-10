import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/account/presentation/archived_chats_screen.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';

void main() {
  testWidgets('hold a sidebar chat, archive it, and restore it from Account', (
    tester,
  ) async {
    final repository = _ArchiveRepository();
    await _pumpApp(tester, repository);
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    await tester.longPress(find.text('My story'));
    await tester.pumpAndSettle();
    expect(find.text('Rename'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
    await tester.tap(find.text('Archive'));
    await tester.pumpAndSettle();
    expect(repository.changes, [true]);
    expect(find.text('My story'), findsNothing);
    expect(find.text('No chats yet'), findsOneWidget);

    await tester.tap(find.text('Account'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const ValueKey('account-archived-chats')),
    );
    await tester.tap(find.byKey(const ValueKey('account-archived-chats')));
    await tester.pumpAndSettle();
    expect(find.byType(ArchivedChatsScreen), findsOneWidget);
    expect(find.text('My story'), findsOneWidget);
    expect(find.text('A story about the sea'), findsOneWidget);

    await tester.tap(find.byTooltip('Unarchive chat'));
    await tester.pumpAndSettle();
    expect(repository.changes, [true, false]);
    expect(find.text('My story'), findsNothing);
    expect(find.text('No archived chats'), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    expect(find.text('My story'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('opening an archived chat preserves its archive state', (
    tester,
  ) async {
    final repository = _ArchiveRepository()..archived = true;
    await _pumpApp(tester, repository, showArchives: true);
    await tester.tap(find.text('My story'));
    await tester.pumpAndSettle();
    expect(find.text('Opened draft-1'), findsOneWidget);
    expect(find.byType(ArchivedChatsScreen), findsNothing);
    expect(repository.archived, isTrue);
    expect(repository.changes, isEmpty);
  });

  testWidgets(
    'failed archive keeps the chat in the sidebar and can be retried',
    (tester) async {
      final repository = _ArchiveRepository()..failChange = true;
      await _pumpApp(tester, repository);
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.longPress(find.text('My story'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(find.text('My story'), findsOneWidget);
      expect(
        find.text('Could not archive the chat. Try again.'),
        findsOneWidget,
      );
      repository.failChange = false;
      await tester.longPress(find.text('My story'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(find.text('My story'), findsNothing);
    },
  );

  testWidgets(
    'failed unarchive keeps the chat and disables repeated taps while saving',
    (tester) async {
      final gate = Completer<void>();
      final repository = _ArchiveRepository()
        ..archived = true
        ..changeGate = gate.future;
      await _pumpApp(tester, repository, showArchives: true);
      await tester.tap(find.byTooltip('Unarchive chat'));
      await tester.pump();
      expect(find.byTooltip('Unarchive chat'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(repository.changes, [false]);
      gate.completeError(Exception('offline'));
      await tester.pumpAndSettle();
      expect(find.text('My story'), findsOneWidget);
      expect(
        find.text('Could not unarchive the chat. Try again.'),
        findsOneWidget,
      );
      repository.changeGate = null;
      await tester.tap(find.byTooltip('Unarchive chat'));
      await tester.pumpAndSettle();
      expect(find.text('No archived chats'), findsOneWidget);
    },
  );

  testWidgets('archived list shows loading and retry after a failed fetch', (
    tester,
  ) async {
    final gate = Completer<List<MobileChatSession>>();
    final repository = _ArchiveRepository()..listGate = gate.future;
    await _pumpApp(tester, repository, showArchives: true, settle: false);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    gate.completeError(Exception('offline'));
    await tester.pumpAndSettle();
    expect(find.text('Archived chats unavailable'), findsOneWidget);
    repository.listGate = null;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('No archived chats'), findsOneWidget);
  });
}

Future<void> _pumpApp(
  WidgetTester tester,
  _ArchiveRepository repository, {
  bool showArchives = false,
  bool settle = true,
}) async {
  final router = GoRouter(
    initialLocation: showArchives ? '/archives' : '/',
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => Scaffold(
          appBar: AppBar(title: const Text('Chats')),
          drawer: const ChatHistoryDrawer(),
          body: const Text('Home'),
        ),
      ),
      GoRoute(path: '/account', builder: (_, _) => const AccountScreen()),
      GoRoute(
        path: '/archives',
        builder: (_, _) => const ArchivedChatsScreen(),
      ),
      GoRoute(
        path: '/books/chat/:id',
        builder: (_, state) =>
            Scaffold(body: Text('Opened ${state.pathParameters['id']}')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(repository),
        projectsProvider.overrideWith((ref) async => []),
        authControllerProvider.overrideWith(_TestAuthController.new),
        billingProvider.overrideWith(
          (ref) async => const MobileBilling(
            credits: CreditBalance(
              available: 0,
              reserved: 0,
              lifetimeGranted: 0,
              lifetimeSpent: 0,
            ),
            entitlements: [],
            products: [],
            creditCosts: {},
          ),
        ),
      ],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        routerConfig: router,
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
  }
}

class _TestAuthController extends AuthController {
  @override
  Future<AuthSession?> build() async => null;
}

class _ArchiveRepository implements CreationRepository {
  bool archived = false;
  bool failChange = false;
  Future<void>? changeGate;
  Future<List<MobileChatSession>>? listGate;
  final changes = <bool>[];

  final session = MobileChatSession(
    draftId: 'draft-1',
    title: 'My story',
    preview: 'A story about the sea',
    messageCount: 2,
    status: 'ACTIVE',
    createdProjectId: null,
    createdAt: DateTime(2026, 9, 10),
    updatedAt: DateTime(2026, 9, 10),
  );

  @override
  Future<List<MobileChatSession>> listSessions() async =>
      archived ? [] : [session];

  @override
  Future<List<MobileChatSession>> listArchivedSessions() async =>
      listGate ?? (archived ? [session] : []);

  @override
  Future<void> setSessionArchived({
    required String draftId,
    required bool archived,
  }) async {
    expect(draftId, session.draftId);
    changes.add(archived);
    if (failChange) throw Exception('offline');
    await changeGate;
    this.archived = archived;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}
