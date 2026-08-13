import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_operations.dart';

// Where an operation card lands in a transcript. Both chat screens share this
// rule, so a fixture here stands in for either of them.

MobileProjectChatMessage _message({
  required String id,
  String role = 'assistant',
  String content = 'reply',
  String? operationId,
}) {
  return MobileProjectChatMessage(
    id: id,
    projectId: 'project-1',
    parentId: null,
    role: role,
    content: content,
    operationId: operationId,
    metadata: const {},
    createdAt: DateTime.utc(2026, 8, 13, 21, 59),
  );
}

MobileBookEditOperation _operation({
  String id = 'op-1',
  String status = 'applied',
  String? anchorMessageId,
}) {
  return MobileBookEditOperation(
    id: id,
    projectId: 'project-1',
    kind: 'add_image',
    status: status,
    affectedPageIndexes: const [1],
    creditsCharged: 45,
    currentAction: 'Illustration replaced on page 1.',
    anchorMessageId: anchorMessageId,
    // Always earlier than the reply: the server writes the operation row first
    // and only then the message announcing it.
    createdAt: DateTime.utc(2026, 8, 13, 21, 58),
  );
}

void main() {
  test('the reply that announced an edit outranks a stale stored anchor', () {
    // The Apply user row is what `anchorMessageId` falls back to until the
    // server stamps the reply onto the operation, and a transcript read inside
    // that window would otherwise put the card above the sentence that
    // introduces it.
    final split = splitTranscriptOperations(
      operations: [_operation(anchorMessageId: 'chat-apply')],
      messages: [
        _message(id: 'chat-apply', role: 'user', content: 'Apply'),
        _message(id: 'chat-reply', operationId: 'op-1'),
      ],
    );

    expect(split.anchoredTo('chat-reply').single.id, 'op-1');
    expect(split.anchoredTo('chat-apply'), isEmpty);
    expect(split.unanchored, isEmpty);
  });

  test('a stored anchor still places a card with no reply of its own', () {
    final split = splitTranscriptOperations(
      operations: [_operation(anchorMessageId: 'chat-apply')],
      messages: [_message(id: 'chat-apply', role: 'user', content: 'Apply')],
    );

    expect(split.anchoredTo('chat-apply').single.id, 'op-1');
    expect(split.unanchored, isEmpty);
  });

  test('an operation with nowhere to sit falls to the end', () {
    final split = splitTranscriptOperations(
      operations: [_operation(anchorMessageId: 'chat-gone')],
      messages: [_message(id: 'chat-reply')],
    );

    expect(split.anchoredTo('chat-reply'), isEmpty);
    expect(split.unanchored.single.id, 'op-1');
  });

  test('running work is shown only where the screen asks for it', () {
    final operations = [
      _operation(status: 'queued', anchorMessageId: 'chat-reply'),
    ];
    final messages = [_message(id: 'chat-reply')];

    final settledOnly = splitTranscriptOperations(
      operations: operations,
      messages: messages,
    );
    expect(settledOnly.anchoredTo('chat-reply'), isEmpty);
    expect(settledOnly.unanchored, isEmpty);

    final withRunning = splitTranscriptOperations(
      operations: operations,
      messages: messages,
      shows: (operation) =>
          operation.isRunning || operation.isApplied || operation.isFailed,
    );
    expect(withRunning.anchoredTo('chat-reply').single.id, 'op-1');
  });
}
