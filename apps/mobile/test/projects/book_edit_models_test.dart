import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

void main() {
  test('parses an editable book with full page markdown and revisions', () {
    final book = MobileEditableBook.fromJson({
      'projectId': 'project-1',
      'title': 'Owned Book',
      'pages': [
        {
          'id': 'page-1',
          'index': 1,
          'title': 'Rabbit Starts Fast',
          'markdown': 'Rabbit runs ahead at the start of the race.',
          'revision': 3,
        },
      ],
    });

    expect(book.projectId, 'project-1');
    expect(book.pages, hasLength(1));
    expect(book.pages.first.markdown, contains('Rabbit runs ahead'));
    expect(book.pages.first.revision, 3);
  });

  test('serializes manual page edits with their base revision', () {
    const edit = MobileManualBookPageEdit(
      id: 'page-1',
      title: 'Rabbit Starts Fast',
      markdown: 'Rabbit sprints ahead.',
      baseRevision: 3,
    );

    expect(edit.toJson(), {
      'id': 'page-1',
      'title': 'Rabbit Starts Fast',
      'markdown': 'Rabbit sprints ahead.',
      'baseRevision': 3,
    });
  });

  test('exposes the saved-export marker from chat message metadata', () {
    final message = MobileProjectChatMessage.fromJson({
      'id': 'chat-1',
      'projectId': 'project-1',
      'role': 'assistant',
      'content': 'You edited pages 1, 2 yourself in Edit Mode.',
      'metadata': {
        'manualEdit': {
          'operationId': 'operation-1',
          'pageIndexes': [1, 2],
          'editCount': 2,
        },
      },
      'createdAt': '2026-06-15T12:00:00.000Z',
    });

    expect(message.manualEdit, isNotNull);
    expect(message.manualEdit!.pageIndexes, [1, 2]);
    expect(message.manualEdit!.editCount, 2);
    expect(message.manualEdit!.operationId, 'operation-1');
  });

  test('leaves manualEdit null on ordinary assistant messages', () {
    final message = MobileProjectChatMessage.fromJson({
      'id': 'chat-2',
      'projectId': 'project-1',
      'role': 'assistant',
      'content': 'Here is your outline.',
      'metadata': const <String, dynamic>{},
      'createdAt': '2026-06-15T12:00:00.000Z',
    });

    expect(message.manualEdit, isNull);
  });

  test('parses a manual edit save result with the saved-export message', () {
    final result = MobileManualBookEditResult.fromJson({
      'messages': [
        {
          'id': 'chat-1',
          'projectId': 'project-1',
          'role': 'assistant',
          'content': 'You edited page 1 yourself in Edit Mode.',
          'metadata': {
            'manualEdit': {
              'operationId': 'operation-1',
              'pageIndexes': [1],
              'editCount': 1,
            },
          },
          'createdAt': '2026-06-15T12:00:00.000Z',
        },
      ],
      'plans': const <dynamic>[],
      'operations': const <dynamic>[],
      'savedExportMessage': {
        'id': 'chat-1',
        'projectId': 'project-1',
        'role': 'assistant',
        'content': 'You edited page 1 yourself in Edit Mode.',
        'metadata': {
          'manualEdit': {
            'operationId': 'operation-1',
            'pageIndexes': [1],
            'editCount': 1,
          },
        },
        'createdAt': '2026-06-15T12:00:00.000Z',
      },
      'operation': {
        'id': 'operation-1',
        'projectId': 'project-1',
        'kind': 'manual_edit',
        'status': 'applied',
        'affectedPageIndexes': [1],
        'creditsCharged': 0,
        'currentAction': 'Edit applied.',
        'createdAt': '2026-06-15T12:00:00.000Z',
        'appliedAt': '2026-06-15T12:00:01.000Z',
      },
    });

    expect(result.savedExportMessage.manualEdit, isNotNull);
    expect(result.operation.kind, 'manual_edit');
    expect(result.operation.isApplied, isTrue);
    expect(result.operation.creditsCharged, 0);
  });
}
