import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_archive_feedback.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

void main() {
  testWidgets('opening an archived chat shows a restore banner', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-1',
          title: 'Archived story',
          archived: true,
        ),
      ],
    );
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-1'));
    await tester.pumpAndSettle();

    expect(find.byType(ArchivedChatBanner), findsOneWidget);
    expect(
      find.text('This chat is archived and hidden from the sidebar.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(TextButton, 'Restore'), findsOneWidget);
    expect(find.byTooltip('Send'), findsOneWidget);
    expect(creation.archiveChanges, isEmpty);

    await tester.tap(find.widgetWithText(TextButton, 'Restore'));
    await tester.pumpAndSettle();

    expect(creation.archiveChanges, [(draftId: 'draft-1', archived: false)]);
    expect(find.byType(ArchivedChatBanner), findsNothing);
    expect(find.text('Chat restored to the sidebar.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'archiving the open chat shows the restore banner without a reload',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [chatSession(draftId: 'draft-1', title: 'My story')],
      );
      await tester.pumpWidget(app(creation: creation, draftId: 'draft-1'));
      await tester.pumpAndSettle();
      expect(find.byType(ArchivedChatBanner), findsNothing);

      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.longPress(
        find.descendant(
          of: find.byType(ChatHistoryDrawer),
          matching: find.text('My story'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();

      expect(creation.archiveChanges, [(draftId: 'draft-1', archived: true)]);
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'restoring the open chat from the shared helper hides the banner',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-1',
            title: 'Archived story',
            archived: true,
          ),
        ],
      );
      final helperRef = await _pumpOpenChat(
        tester,
        creation: creation,
        draftId: 'draft-1',
      );
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      final restored = await setChatArchivedWithFeedback(
        ref: helperRef,
        messenger: ScaffoldMessenger.of(
          tester.element(find.byType(CreationChatScreen)),
        ),
        draftId: 'draft-1',
        archived: false,
      );
      await tester.pumpAndSettle();

      expect(restored, isTrue);
      expect(creation.archiveChanges, [(draftId: 'draft-1', archived: false)]);
      expect(find.byType(ArchivedChatBanner), findsNothing);
      expect(find.text('Chat restored to the sidebar.'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('restore while in flight ignores a second tap', (tester) async {
    final gate = Completer<void>();
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-1',
          title: 'Archived story',
          archived: true,
        ),
      ],
    )..changeGate = gate.future;
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-1'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(TextButton, 'Restore'));
    await tester.pump();
    expect(creation.archiveChanges, [(draftId: 'draft-1', archived: false)]);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Restore'))
          .onPressed,
      isNull,
    );

    await tester.tap(find.widgetWithText(TextButton, 'Restore'));
    await tester.pump();
    expect(creation.archiveChanges, [(draftId: 'draft-1', archived: false)]);

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byType(ArchivedChatBanner), findsNothing);
    expect(find.text('Chat restored to the sidebar.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'a late unarchived conversation reply does not hide the restore banner',
    (tester) async {
      final sendGate = Completer<void>();
      final creation = ScriptedCreationRepository(
        sessions: [chatSession(draftId: 'draft-1', title: 'My story')],
      )..sendGate = sendGate.future;
      await tester.pumpWidget(app(creation: creation, draftId: 'draft-1'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.longPress(
        find.descendant(
          of: find.byType(ChatHistoryDrawer),
          matching: find.text('My story'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      final send = ProviderScope.containerOf(
        tester.element(find.byType(CreationChatScreen)),
      ).read(creationChatControllerProvider.notifier).sendMessage('Keep going');
      sendGate.complete();
      await send;
      await tester.pumpAndSettle();

      expect(find.byType(ArchivedChatBanner), findsOneWidget);
      expect(find.text(reply), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'an in-flight /active resume does not replace an archived home chat',
    (tester) async {
      final resumeGate = Completer<void>();
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(draftId: 'draft-1', title: 'My story'),
          chatSession(draftId: 'draft-2', title: 'Other story'),
        ],
      );
      await _pumpHomeChat(tester, creation);
      final resume = _startGatedActiveResume(
        tester,
        creation: creation,
        resumeGate: resumeGate,
      );
      await tester.pump();
      await _archiveOpenHomeChat(tester);
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      resumeGate.complete();
      await resume;
      await tester.pumpAndSettle();

      final state = ProviderScope.containerOf(
        tester.element(find.byType(CreationChatScreen)),
      ).read(creationChatControllerProvider);
      expect(state.draftId, 'draft-1');
      expect(state.archived, isTrue);
      expect(state.sessionTitle, 'My story');
      expect(find.byType(ArchivedChatBanner), findsOneWidget);
      expect(find.text('Selected chat draft-2'), findsNothing);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'an in-flight /active resume keeps a local archive on the same draft',
    (tester) async {
      final resumeGate = Completer<void>();
      final creation = ScriptedCreationRepository(
        sessions: [chatSession(draftId: 'draft-1', title: 'My story')],
      );
      await _pumpHomeChat(tester, creation);
      final resume = _startGatedActiveResume(
        tester,
        creation: creation,
        resumeGate: resumeGate,
      );
      await tester.pump();
      await _archiveOpenHomeChat(tester);
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      creation.resumeConversationResult = _homeConversation(
        draftId: 'draft-1',
        title: 'My story',
        archived: false,
      );
      resumeGate.complete();
      await resume;
      await tester.pumpAndSettle();

      final state = ProviderScope.containerOf(
        tester.element(find.byType(CreationChatScreen)),
      ).read(creationChatControllerProvider);
      expect(state.draftId, 'draft-1');
      expect(state.archived, isTrue);
      expect(find.byType(ArchivedChatBanner), findsOneWidget);

      await tester.teardownScreen();
    },
  );
}

Future<WidgetRef> _pumpOpenChat(
  WidgetTester tester, {
  required CreationRepository creation,
  required String draftId,
}) async {
  late WidgetRef helperRef;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiAuthHeadersProvider.overrideWith(
          (ref) async => const <String, String>{},
        ),
        creationRepositoryProvider.overrideWithValue(creation),
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        creationPrefsStoreProvider.overrideWithValue(
          MemoryCreationPrefsStore(),
        ),
      ],
      child: Consumer(
        builder: (context, ref, _) {
          helperRef = ref;
          return MaterialApp(
            theme: buildTomezaLightTheme(),
            home: CreationChatScreen(draftId: draftId),
          );
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
  return helperRef;
}

Future<void> _pumpHomeChat(
  WidgetTester tester,
  ScriptedCreationRepository creation,
) async {
  await tester.pumpWidget(app(creation: creation));
  await tester.pumpAndSettle();
}

Future<void> _startGatedActiveResume(
  WidgetTester tester, {
  required ScriptedCreationRepository creation,
  required Completer<void> resumeGate,
}) {
  creation.resumeGate = resumeGate.future;
  return ProviderScope.containerOf(
    tester.element(find.byType(CreationChatScreen)),
  ).read(creationChatControllerProvider.notifier).init(force: true);
}

Future<void> _archiveOpenHomeChat(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Open navigation menu'));
  await tester.pumpAndSettle();
  await tester.longPress(
    find.descendant(
      of: find.byType(ChatHistoryDrawer),
      matching: find.text('My story'),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('Archive'));
  await tester.pumpAndSettle();
}

MobileCreationConversationResponse _homeConversation({
  required String draftId,
  required String title,
  required bool archived,
}) {
  return MobileCreationConversationResponse.fromJson({
    'session': {
      'draftId': draftId,
      'title': title,
      'status': 'ACTIVE',
      'archived': archived,
      'messages': [
        {'role': 'assistant', 'content': 'Selected chat $draftId'},
      ],
      'updatedAt': '2026-06-15T00:00:00.000Z',
    },
    'turn': turnJson(
      assistantMessage: 'Selected chat $draftId',
      canBuild: false,
      quickReplies: const [],
    ),
  });
}
