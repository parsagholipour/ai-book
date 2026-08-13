import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/pending_chat_sessions.dart';
import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// A chat created mid-send: switching away, the drawer's in-progress tile, and
// the save that must land even after the screen is gone. Split from
// creation_chat_test.dart along the pending-session seam to keep that file
// inside its size budget.

void main() {
  testWidgets('a new chat started mid-send survives switching chats', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Switch to another chat while the first send is still running.
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
    await tester.pumpAndSettle();
    expect(find.text('Selected chat draft-b'), findsOneWidget);

    final container = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
      listen: false,
    );
    final callsBefore = creation.listSessionsCalls;

    sendGate.complete();
    await tester.pumpAndSettle();

    // The created chat is cached, so it is reachable again without reopening
    // the app.
    expect(
      container.read(creationConversationCacheProvider).readById('draft-1'),
      isNotNull,
    );
    // The chat the user switched to is untouched by the stale response.
    expect(find.text('Selected chat draft-b'), findsOneWidget);
    expect(find.text(reply), findsNothing);

    // The sessions list was invalidated, and nothing watches it until the
    // drawer opens — which is when the refetch lands.
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    expect(creation.listSessionsCalls, greaterThan(callsBefore));

    await tester.teardownScreen();
  });

  testWidgets('drawer shows an in-progress tile for a chat being created', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository(sessions: <MobileChatSession>[])
      ..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Timed pumps: the pending tile's indeterminate spinner animates forever,
    // so pumpAndSettle would never settle while the send is in flight.
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final drawerTile = find.descendant(
      of: find.byType(ChatHistoryDrawer),
      matching: find.text('My new book idea'),
    );
    expect(find.text('In progress'), findsOneWidget);
    expect(drawerTile, findsOneWidget);
    expect(find.text('Creating…'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(ChatHistoryDrawer),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );

    // Tapping while still creating explains instead of navigating.
    await tester.tap(drawerTile);
    await tester.pump();
    expect(
      find.text('Still creating this chat — it will be ready in a moment.'),
      findsOneWidget,
    );
    expect(find.byType(ChatHistoryDrawer), findsOneWidget);

    // Once the send finishes and the refreshed list contains the chat, the
    // real tile takes over.
    creation.sessions.add(
      chatSession(draftId: 'draft-1', title: 'My new book idea'),
    );
    sendGate.complete();
    await tester.pumpAndSettle();

    expect(find.text('In progress'), findsNothing);
    expect(find.text('Creating…'), findsNothing);
    expect(drawerTile, findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a failed send after switching chats does not touch the open '
      'chat', (tester) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
      listen: false,
    );

    sendGate.completeError(Exception('offline'));
    await tester.pumpAndSettle();

    final state = container.read(creationChatControllerProvider);
    expect(state.initError, isNull);
    expect(state.messages.any((message) => message.isFailedSend), isFalse);
    expect(container.read(pendingChatSessionsProvider), isEmpty);
    expect(find.text('Selected chat draft-b'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a new chat finishing after leaving the screen is still saved', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;

    Widget shell(Widget home) => ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(creation),
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      ],
      child: MaterialApp(theme: buildTomezaLightTheme(), home: home),
    );

    await tester.pumpWidget(shell(const CreationChatScreen(startFresh: true)));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Leave the chat area entirely; the controller has no listeners left.
    await tester.pumpWidget(shell(const Scaffold(body: Text('Account'))));
    await tester.pump();

    final container = ProviderScope.containerOf(
      tester.element(find.text('Account')),
      listen: false,
    );

    sendGate.complete();
    await tester.pumpAndSettle();

    expect(
      container.read(creationConversationCacheProvider).readById('draft-1'),
      isNotNull,
    );
    final pending = container.read(pendingChatSessionsProvider);
    expect(pending, hasLength(1));
    expect(pending.single.draftId, 'draft-1');

    await tester.teardownScreen();
  });
}
