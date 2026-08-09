import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';

void main() {
  testWidgets('new book button uses a pen-on-paper icon', (tester) async {
    await tester.pumpWidget(_app(sessions: const [], activeDraftId: ''));
    await tester.pumpAndSettle();

    final button = find.widgetWithText(FilledButton, 'New book');
    expect(button, findsOneWidget);
    expect(
      find.descendant(of: button, matching: find.byIcon(Icons.edit_document)),
      findsOneWidget,
    );
  });

  testWidgets('drawer load errors offer retry', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          creationRepositoryProvider.overrideWithValue(
            _ThrowingCreationRepository(),
          ),
          billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const Scaffold(body: ChatHistoryDrawer()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Chats unavailable'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pump();
  });

  testWidgets('active chat background stays inside the clipped list', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 520));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final sessions = List.generate(
      24,
      (index) => _chatSession(draftId: 'draft-$index', title: 'Chat $index'),
    );

    await tester.pumpWidget(_app(sessions: sessions, activeDraftId: 'draft-0'));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('chat-history-scroll-clip')),
      findsOneWidget,
    );

    final selectedTile = tester.widget<ListTile>(
      find.widgetWithText(ListTile, 'Chat 0'),
    );
    expect(selectedTile.selected, isTrue);
    expect(selectedTile.selectedTileColor, Colors.transparent);

    final selectedColor = buildTomezaLightTheme().colorScheme.primaryContainer
        .withValues(alpha: 0.55);
    expect(
      find.ancestor(
        of: find.text('Chat 0'),
        matching: find.byWidgetPredicate(
          (widget) => widget is Material && widget.color == selectedColor,
        ),
      ),
      findsOneWidget,
    );

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -240));
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('date header stays pinned while its chats scroll under it', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final sessions = List.generate(
      24,
      (index) => _chatSession(
        draftId: 'draft-$index',
        title: 'Chat $index',
        lastMessageAt: now,
      ),
    );

    await tester.pumpWidget(_app(sessions: sessions, activeDraftId: 'other'));
    await tester.pumpAndSettle();

    final listTop = tester.getTopLeft(find.byType(CustomScrollView)).dy;
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Chat 0'), findsOneWidget);

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -300));
    await tester.pumpAndSettle();

    // The first chats scrolled away but the group label held the top edge.
    expect(find.text('Chat 0'), findsNothing);
    expect(find.text('Today'), findsOneWidget);
    final headerTop = tester.getTopLeft(find.text('Today')).dy;
    expect(headerTop, greaterThanOrEqualTo(listTop));
    expect(headerTop, lessThan(listTop + 24));
  });

  testWidgets('sessions group by last message time, not row update time', (
    tester,
  ) async {
    final now = DateTime.now();
    final session = MobileChatSession(
      draftId: 'draft-0',
      title: 'Old Portuguese book',
      preview: 'Latest message',
      messageCount: 2,
      status: 'ACTIVE',
      createdAt: now.subtract(const Duration(days: 30)),
      // The row was touched today (e.g. by a build), but the conversation
      // itself is a month old.
      updatedAt: now,
      lastMessageAt: now.subtract(const Duration(days: 30)),
    );

    await tester.pumpWidget(_app(sessions: [session], activeDraftId: 'other'));
    await tester.pumpAndSettle();

    expect(find.text('Older'), findsOneWidget);
    expect(find.text('Today'), findsNothing);
  });

  test('fromJson falls back to updatedAt when lastMessageAt is missing', () {
    final json = <String, dynamic>{
      'draftId': 'draft-0',
      'title': 'Legacy chat',
      'preview': '',
      'messageCount': 1,
      'status': 'ACTIVE',
      'createdAt': '2026-06-01T00:00:00.000Z',
      'updatedAt': '2026-06-15T00:00:00.000Z',
    };

    final legacy = MobileChatSession.fromJson(json);
    expect(legacy.lastMessageAt, DateTime.parse('2026-06-15T00:00:00.000Z'));

    final current = MobileChatSession.fromJson({
      ...json,
      'lastMessageAt': '2026-06-10T00:00:00.000Z',
    });
    expect(current.lastMessageAt, DateTime.parse('2026-06-10T00:00:00.000Z'));
  });
}

Widget _app({
  required List<MobileChatSession> sessions,
  required String activeDraftId,
}) {
  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(
        _FakeCreationRepository(sessions),
      ),
      billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Scaffold(body: ChatHistoryDrawer(activeDraftId: activeDraftId)),
    ),
  );
}

MobileChatSession _chatSession({
  required String draftId,
  required String title,
  DateTime? lastMessageAt,
}) {
  final now = DateTime.utc(2026, 6, 15);
  return MobileChatSession(
    draftId: draftId,
    title: title,
    preview: 'Latest message',
    messageCount: 2,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: lastMessageAt,
  );
}

class _FakeCreationRepository implements CreationRepository {
  const _FakeCreationRepository(this.sessions);

  final List<MobileChatSession> sessions;

  @override
  Future<List<MobileChatSession>> listSessions() async => sessions;

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _ThrowingCreationRepository implements CreationRepository {
  @override
  Future<List<MobileChatSession>> listSessions() async {
    throw Exception('network down');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => _billing();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileBilling _billing() {
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
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}
