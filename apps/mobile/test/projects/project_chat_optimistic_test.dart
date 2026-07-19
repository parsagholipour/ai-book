import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

void main() {
  testWidgets('a sent message appears immediately while the request is in '
      'flight and stays after it lands', (tester) async {
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Make chapter two warmer');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();

    // Optimistic echo: visible before the server has replied.
    expect(find.text('Make chapter two warmer'), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();

    // Now part of the refreshed transcript, exactly once.
    expect(find.text('Make chapter two warmer'), findsOneWidget);
    expect(find.text('Reply about Make chapter two warmer'), findsOneWidget);
  });

  testWidgets('a failed send shows a retry bubble and never clobbers text '
      'typed while waiting', (tester) async {
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'First message');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();

    // The user keeps typing while the send is in flight.
    await tester.enterText(find.byType(TextField), 'Typed meanwhile');

    gate.completeError(
      const ApiException(code: 'NETWORK_ERROR', message: 'Offline'),
    );
    await tester.pumpAndSettle();

    expect(find.text('First message'), findsOneWidget);
    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.controller?.text, 'Typed meanwhile');
  });

  testWidgets('retrying a failed send reuses the original request ID', (
    tester,
  ) async {
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Retry me');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();
    gate.completeError(
      const ApiException(code: 'NETWORK_ERROR', message: 'Offline'),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(repository.sendRequestIds, hasLength(2));
    expect(repository.sendRequestIds[1], repository.sendRequestIds[0]);
    expect(find.text('Retry me'), findsOneWidget);
    expect(find.text('Reply about Retry me'), findsOneWidget);
  });

  testWidgets('dismissing a failed send hands the text back to the empty '
      'composer', (tester) async {
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Dismiss me');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();
    gate.completeError(
      const ApiException(code: 'NETWORK_ERROR', message: 'Offline'),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Dismiss'));
    await tester.pumpAndSettle();

    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.controller?.text, 'Dismiss me');
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('a failed inline edit keeps the edited text in the editor', (
    tester,
  ) async {
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.editGates.add(gate);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Edit message'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField).first,
      'Edited but doomed',
    );
    await tester.tap(find.text('Save & Submit'));
    await tester.pump();
    gate.completeError(
      const ApiException(code: 'NETWORK_ERROR', message: 'Offline'),
    );
    await tester.pumpAndSettle();

    // The inline editor stays open with the user's text intact.
    expect(find.text('Save & Submit'), findsOneWidget);
    final editor = tester.widget<TextField>(find.byType(TextField).first);
    expect(editor.controller?.text, 'Edited but doomed');
  });
}

Widget _app(_ScriptedProjectsRepository repository) {
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: const MaterialApp(home: ProjectChatScreen(projectId: 'project-1')),
  );
}

/// Fake linear-chat repository whose send/edit calls can be gated to resolve
/// or fail on demand.
class _ScriptedProjectsRepository implements ProjectsRepository {
  final _contents = <({String role, String content})>[
    (role: 'assistant', content: 'Hi! What should we edit?'),
    (role: 'user', content: 'Existing user message'),
  ];
  final sendGates = <Completer<void>>[];
  final editGates = <Completer<void>>[];
  final sendRequestIds = <String?>[];
  final editRequestIds = <String?>[];

  MobileProjectChat _chat() {
    return MobileProjectChat(
      messages: [
        for (final (index, entry) in _contents.indexed)
          MobileProjectChatMessage(
            id: 'm$index',
            projectId: 'project-1',
            parentId: index == 0 ? null : 'm${index - 1}',
            role: entry.role,
            content: entry.content,
            metadata: const {},
            createdAt: DateTime.utc(2026, 6, 15).add(Duration(minutes: index)),
          ),
      ],
      operations: const [],
    );
  }

  MobileProjectChatSendResult _appendTurn(String message) {
    _contents.add((role: 'user', content: message));
    _contents.add((role: 'assistant', content: 'Reply about $message'));
    final chat = _chat();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: chat.messages.last,
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return _chat();
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
  }) async {
    sendRequestIds.add(requestId);
    if (sendGates.isNotEmpty) {
      await sendGates.removeAt(0).future;
    }
    return _appendTurn(message);
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
  }) async {
    editRequestIds.add(requestId);
    if (editGates.isNotEmpty) {
      await editGates.removeAt(0).future;
    }
    return _appendTurn(message);
  }

  @override
  Future<MobileProjectDetail> getProject(String id) {
    // Keeps the app bar on its 'Book chat' fallback title.
    return Future<MobileProjectDetail>.error(
      UnimplementedError('Project detail is not used in this test.'),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
