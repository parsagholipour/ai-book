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
  Map<String, dynamic> metadata = const {},
}) {
  return MobileProjectChatMessage(
    id: id,
    projectId: 'project-1',
    parentId: null,
    role: role,
    content: content,
    operationId: operationId,
    metadata: metadata,
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
  test('an Undo reply re-homes the card under that turn', () {
    final split = splitTranscriptOperations(
      operations: [_operation(anchorMessageId: 'chat-reply')],
      messages: [
        _message(id: 'chat-reply', operationId: 'op-1'),
        _message(id: 'chat-undo', operationId: 'op-1', content: 'rebuilding'),
      ],
    );

    expect(split.anchoredTo('chat-undo').single.id, 'op-1');
    expect(split.anchoredTo('chat-reply'), isEmpty);
  });

  test(
    'an Undo reply with only metadata re-homes the card under that turn',
    () {
      final split = splitTranscriptOperations(
        operations: [_operation(anchorMessageId: 'chat-reply')],
        messages: [
          _message(id: 'chat-reply', operationId: 'op-1'),
          _message(
            id: 'chat-undo',
            content: 'rebuilding',
            metadata: {
              'undo': {
                'operationId': 'op-1',
                'restoredPageIndexes': [1],
              },
            },
          ),
        ],
      );

      expect(split.anchoredTo('chat-undo').single.id, 'op-1');
      expect(split.anchoredTo('chat-reply'), isEmpty);
    },
  );

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
    expect(settledOnly.hasRunning, isFalse);

    final withRunning = splitTranscriptOperations(
      operations: operations,
      messages: messages,
      shows: (operation) =>
          operation.isRunning || operation.isApplied || operation.isFailed,
    );
    expect(withRunning.anchoredTo('chat-reply').single.id, 'op-1');
    expect(withRunning.hasRunning, isTrue);
  });

  test('UndoRedoRebuildView rebuilds only the in-flight operation', () {
    final view = undoRedoRebuildView(
      messages: [
        _message(
          id: 'chat-undo',
          operationId: 'op-1',
          content: 'rebuilding',
          metadata: {
            'undo': {
              'operationId': 'op-1',
              'restoredPageIndexes': [1],
            },
          },
        ),
      ],
      awaitingRebuild: true,
      liveEditing: false,
    );

    expect(view.operationId, 'op-1');
    expect(view.inFlight, isTrue);
    expect(view.isRebuilding('op-1'), isTrue);
    expect(view.isRebuilding('op-2'), isFalse);
  });

  test('UndoRedoRebuildView prefers the local handoff id', () {
    final view = undoRedoRebuildView(
      messages: const [],
      localRebuildOperationId: 'op-local',
      awaitingRebuild: false,
      liveEditing: true,
    );

    expect(view.operationId, 'op-local');
    expect(view.isRebuilding('op-local'), isTrue);
  });

  test('UndoRedoRebuildHandoff ignores a COMPLETE with the same updatedAt', () {
    final handoff = UndoRedoRebuildHandoff();
    final before = _status();
    handoff.arm(_undoSendResult(), currentStatus: before);

    expect(handoff.awaiting, isTrue);
    expect(handoff.operationId, 'op-1');
    expect(handoff.inFlight, isTrue);
    expect(handoff.shouldSettle(_status(status: 'editing')), isFalse);
    expect(handoff.shouldSettle(before), isFalse);
    expect(handoff.shouldSettle(_status()), isFalse);

    final rebuilt = _status(updatedAt: DateTime.utc(2026, 6, 15, 13));
    expect(handoff.shouldSettle(rebuilt), isTrue);
    handoff.clear();
    expect(handoff.inFlight, isFalse);
    expect(handoff.shouldSettle(rebuilt), isFalse);
  });
}

MobileProjectChatSendResult _undoSendResult() {
  final reply = _message(
    id: 'chat-undo',
    content: 'rebuilding',
    operationId: 'op-1',
    metadata: {
      'undo': {
        'operationId': 'op-1',
        'restoredPageIndexes': [1],
      },
    },
  );
  return MobileProjectChatSendResult(
    messages: [reply],
    operations: const [],
    reply: reply,
  );
}

MobileProjectStatus _status({String status = 'complete', DateTime? updatedAt}) {
  return MobileProjectStatus.fromJson({
    'projectId': 'project-1',
    'status': status,
    'statusLabel': status,
    'progressPercent': status == 'editing' ? 50 : 100,
    'currentAction': '',
    'retryAvailable': false,
    'steps': <Object?>[],
    'pageProgress': {'completed': 1, 'target': 1},
    'imageCount': 0,
    'exports': {
      'pdf': {
        'format': 'pdf',
        'available': false,
        'unlocked': true,
        'creditsRequired': 0,
        'downloadUrl': '',
        'filename': 'book.pdf',
        'contentType': 'application/pdf',
      },
      'epub': {
        'format': 'epub',
        'available': false,
        'unlocked': true,
        'creditsRequired': 0,
        'downloadUrl': '',
        'filename': 'book.epub',
        'contentType': 'application/epub+zip',
      },
    },
    'updatedAt': (updatedAt ?? DateTime.utc(2026, 6, 15)).toIso8601String(),
  });
}
