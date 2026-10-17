import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/chat_thinking_bubble.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

class _StreamingProjects extends PlanProjectsRepository {
  _StreamingProjects()
    : super(
        project: plannedProject(status: 'complete', plan: approvedPlan()),
      );

  void Function(String)? emitAssistantText;
  Future<void>? chatReadGate;

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    await chatReadGate;
    return super.getProjectChat(
      id,
      beforeMessageId: beforeMessageId,
      limit: limit,
    );
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    void Function(String text)? onAssistantText,
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  }) {
    emitAssistantText = onAssistantText;
    return super.sendProjectChatMessage(
      projectId: projectId,
      message: message,
      requestId: requestId,
      replyToMessageId: replyToMessageId,
    );
  }
}

void main() {
  testWidgets(
    'saved streamed reply survives a slow and failed transcript read',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Completed book',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      final projects = _StreamingProjects();
      final send = Completer<void>();
      projects.sendGate = send;
      projects.nextSendReplyMetadata = const {
        'contentCard': {
          'type': 'outline',
          'title': 'Saved book details',
          'sections': [
            {'label': 'The ending', 'body': 'The fox finds a home.'},
          ],
        },
      };
      await tester.pumpWidget(
        app(creation: creation, projects: projects, draftId: 'draft-done'),
      );
      await tester.pumpAndSettle();
      final container = ProviderScope.containerOf(
        tester.element(find.byType(CreationChatScreen)),
      );
      await tester.enterText(find.byType(TextField).last, 'Explain the ending');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      projects.emitAssistantText!('A partial answer');
      await tester.pump();
      // The transcript follows the reply with a short glide; let it land
      // before looking for the bubble at the bottom.
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('A partial answer'), findsOneWidget);

      final read = Completer<void>();
      projects.chatReadGate = read.future;
      send.complete();
      await tester.pumpAndSettle();
      expect(find.text('A partial answer'), findsNothing);
      expect(find.text('I can help edit this book.'), findsOneWidget);
      expect(find.text('Saved book details'), findsOneWidget);
      expect(find.byType(ChatThinkingBubble), findsNothing);

      read.completeError(StateError('Connection lost during transcript read'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('I can help edit this book.'), findsOneWidget);
      expect(find.text('Saved book details'), findsOneWidget);

      projects.chatReadGate = null;
      projects.chatMessages.add(
        MobileProjectChatMessage(
          id: 'another-saved-turn',
          projectId: 'project-1',
          role: 'assistant',
          content: 'A later saved update',
          metadata: const {},
          createdAt: DateTime.utc(2026, 6, 15, 13),
        ),
      );
      container.invalidate(projectChatProvider('project-1'));
      await tester.pumpAndSettle();
      expect(find.text('A later saved update'), findsOneWidget);
      expect(find.text('I can help edit this book.'), findsOneWidget);
      await tester.teardownScreen();
    },
  );
}
