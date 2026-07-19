import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

void main() {
  testWidgets('editing a project chat message forks a branch with arrows', (
    tester,
  ) async {
    final repository = _BranchingProjectsRepository();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('Make the dragon nicer'), findsOneWidget);

    await tester.tap(find.byTooltip('Edit message'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField).first,
      'Make the dragon scarier',
    );
    await tester.tap(find.text('Save & Submit'));
    await tester.pumpAndSettle();

    expect(repository.editedMessageIds, ['u1']);
    expect(find.text('Make the dragon scarier'), findsOneWidget);
    expect(find.text('Make the dragon nicer'), findsNothing);
    expect(find.text('2/2'), findsOneWidget);
  });

  testWidgets('branch arrows move between sibling threads', (tester) async {
    final repository = _BranchingProjectsRepository();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Edit message'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField).first,
      'Make the dragon scarier',
    );
    await tester.tap(find.text('Save & Submit'));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Previous branch'));
    await tester.pumpAndSettle();

    expect(find.text('Make the dragon nicer'), findsOneWidget);
    expect(find.text('Reply about nicer'), findsOneWidget);
    expect(find.text('Make the dragon scarier'), findsNothing);
    expect(find.text('1/2'), findsOneWidget);

    await tester.tap(find.byTooltip('Next branch'));
    await tester.pumpAndSettle();

    expect(find.text('Make the dragon scarier'), findsOneWidget);
    expect(find.text('Make the dragon nicer'), findsNothing);
    expect(find.text('2/2'), findsOneWidget);
  });

  testWidgets(
    'loads earlier project chat messages from the pagination cursor',
    (tester) async {
      final repository = _BranchingProjectsRepository(paginated: true);
      await tester.pumpWidget(_app(repository));
      await tester.pumpAndSettle();

      expect(find.text('Hi! What should we edit?'), findsNothing);
      expect(find.text('Load earlier messages'), findsOneWidget);

      await tester.tap(find.text('Load earlier messages'));
      await tester.pumpAndSettle();

      expect(find.text('Hi! What should we edit?'), findsOneWidget);
      expect(find.text('Load earlier messages'), findsNothing);
    },
  );
}

Widget _app(_BranchingProjectsRepository repository) {
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: const MaterialApp(home: ProjectChatScreen(projectId: 'project-1')),
  );
}

class _Node {
  _Node({
    required this.id,
    required this.parentId,
    required this.role,
    required this.content,
  });

  final String id;
  final String? parentId;
  final String role;
  final String content;
  bool isActiveChild = true;
}

/// Fake repository that models a real message tree the way the server does:
/// edits fork a sibling branch and switching flips the active sibling.
class _BranchingProjectsRepository implements ProjectsRepository {
  _BranchingProjectsRepository({this.paginated = false}) {
    _nodes.addAll([
      _Node(
        id: 'a1',
        parentId: null,
        role: 'assistant',
        content: 'Hi! What should we edit?',
      ),
      _Node(
        id: 'u1',
        parentId: 'a1',
        role: 'user',
        content: 'Make the dragon nicer',
      ),
      _Node(
        id: 'a2',
        parentId: 'u1',
        role: 'assistant',
        content: 'Reply about nicer',
      ),
    ]);
  }

  final _nodes = <_Node>[];
  final bool paginated;
  final editedMessageIds = <String>[];
  int _nextId = 0;

  List<_Node> _children(String? parentId) =>
      _nodes.where((node) => node.parentId == parentId).toList();

  _Node? _selected(List<_Node> siblings) {
    if (siblings.isEmpty) return null;
    return siblings.lastWhere(
      (node) => node.isActiveChild,
      orElse: () => siblings.last,
    );
  }

  MobileProjectChat _chat() {
    final messages = <MobileProjectChatMessage>[];
    var next = _selected(_children(null));
    while (next != null) {
      final siblings = _children(next.parentId);
      messages.add(
        MobileProjectChatMessage(
          id: next.id,
          projectId: 'project-1',
          parentId: next.parentId,
          role: next.role,
          content: next.content,
          metadata: const {},
          createdAt: DateTime.utc(2026, 6, 15),
          branch: siblings.length > 1
              ? MobileProjectChatBranch(
                  index: siblings.indexOf(next) + 1,
                  total: siblings.length,
                  canGoPrevious: siblings.indexOf(next) > 0,
                  canGoNext: siblings.indexOf(next) < siblings.length - 1,
                )
              : null,
        ),
      );
      next = _selected(_children(next.id));
    }
    return MobileProjectChat(messages: messages, operations: const []);
  }

  MobileProjectChatSendResult _appendTurn({
    required String? parentId,
    required String message,
  }) {
    final userId = 'new-u${_nextId++}';
    for (final sibling in _children(parentId)) {
      sibling.isActiveChild = false;
    }
    _nodes.add(
      _Node(id: userId, parentId: parentId, role: 'user', content: message),
    );
    _nodes.add(
      _Node(
        id: 'new-a${_nextId++}',
        parentId: userId,
        role: 'assistant',
        content: 'Reply about $message',
      ),
    );
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
    final chat = _chat();
    if (!paginated) return chat;
    if (beforeMessageId == null) {
      return MobileProjectChat(
        messages: chat.messages.skip(1).toList(),
        operations: chat.operations,
        hasMore: true,
        nextCursor: chat.messages[1].id,
      );
    }
    return MobileProjectChat(
      messages: [chat.messages.first],
      operations: chat.operations,
    );
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
  }) async {
    return _appendTurn(parentId: _chat().messages.last.id, message: message);
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
  }) async {
    editedMessageIds.add(messageId);
    final edited = _nodes.firstWhere((node) => node.id == messageId);
    return _appendTurn(parentId: edited.parentId, message: message);
  }

  @override
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) async {
    final current = _nodes.firstWhere((node) => node.id == messageId);
    final siblings = _children(current.parentId);
    final index = siblings.indexOf(current);
    final target = siblings[direction == 'previous' ? index - 1 : index + 1];
    for (final sibling in siblings) {
      sibling.isActiveChild = sibling.id == target.id;
    }
    return _chat();
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
