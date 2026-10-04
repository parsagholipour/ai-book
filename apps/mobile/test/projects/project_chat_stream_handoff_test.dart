import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/chat_thinking_bubble.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

import 'project_chat_harness_optimistic.dart';

class _StreamingProjects extends ScriptedProjectsRepository {
  Future<void>? chatReadGate;
  MobileProjectChat? savedChat;

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    await chatReadGate;
    return savedChat ??
        await super.getProjectChat(
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
  }) async => _saveWithCard(
    await super.sendProjectChatMessage(
      onAssistantText: onAssistantText,
      projectId: projectId,
      message: message,
      requestId: requestId,
    ),
  );

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    void Function(String text)? onAssistantText,
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
    List<String>? mentionedCharacterIds,
  }) async {
    emitAssistantText = onAssistantText;
    return _saveWithCard(
      await super.editProjectChatMessage(
        projectId: projectId,
        messageId: messageId,
        message: message,
        requestId: requestId,
      ),
    );
  }

  MobileProjectChatSendResult _saveWithCard(
    MobileProjectChatSendResult result,
  ) {
    final reply = MobileProjectChatMessage(
      id: result.reply.id,
      projectId: result.reply.projectId,
      parentId: result.reply.parentId,
      role: 'assistant',
      content: result.reply.content,
      metadata: const {
        'contentCard': {
          'type': 'outline',
          'title': 'Saved book details',
          'sections': [
            {'label': 'The ending', 'body': 'The fox finds a home.'},
          ],
        },
      },
      createdAt: result.reply.createdAt,
    );
    final saved = MobileProjectChatSendResult(
      messages: [
        for (final message in result.messages)
          if (message.id == reply.id) reply else message,
      ],
      operations: result.operations,
      reply: reply,
    );
    savedChat = saved;
    return saved;
  }
}

void main() {
  for (final editing in [false, true]) {
    testWidgets(
      '${editing ? "edited" : "sent"} streamed reply survives slow and failed transcript reads',
      (tester) async {
        final repository = _StreamingProjects();
        final send = Completer<void>();
        (editing ? repository.editGates : repository.sendGates).add(send);
        await tester.pumpWidget(chatApp(repository));
        await tester.pumpAndSettle();
        final container = ProviderScope.containerOf(
          tester.element(find.byType(ProjectChatScreen)),
        );
        if (editing) {
          await tester.tap(find.byTooltip('Edit message'));
          await tester.pumpAndSettle();
          await tester.enterText(
            find.byType(TextField).first,
            'Explain the ending',
          );
          await tester.tap(find.text('Save & Submit'));
        } else {
          await tester.enterText(find.byType(TextField), 'Explain the ending');
          await tester.tap(find.byIcon(Icons.send_outlined));
        }
        await tester.pump();
        repository.emitAssistantText!('A partial answer');
        await tester.pump();
        expect(find.text('A partial answer'), findsOneWidget);

        final read = Completer<void>();
        repository.chatReadGate = read.future;
        send.complete();
        await tester.pumpAndSettle();
        expect(find.text('A partial answer'), findsNothing);
        expect(find.text('Reply about Explain the ending'), findsOneWidget);
        expect(find.text('Saved book details'), findsOneWidget);
        expect(find.byType(ChatThinkingBubble), findsNothing);

        read.completeError(
          StateError('Connection lost during transcript read'),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Reply about Explain the ending'), findsOneWidget);
        expect(find.text('Saved book details'), findsOneWidget);

        repository.chatReadGate = null;
        repository.savedChat = MobileProjectChat(
          messages: [
            ...repository.savedChat!.messages,
            MobileProjectChatMessage(
              id: 'later',
              projectId: 'project-1',
              role: 'assistant',
              content: 'A later saved update',
              metadata: const {},
              createdAt: DateTime.utc(2026, 10, 5),
            ),
          ],
          operations: const [],
        );
        container.invalidate(projectChatProvider('project-1'));
        await tester.pumpAndSettle();
        expect(find.text('A later saved update'), findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      },
    );
  }
}
