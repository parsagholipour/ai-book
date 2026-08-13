import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

void main() {
  testWidgets('applying a replan lands on the rebuilt book, not the untouched '
      'one', (tester) async {
    // A replan builds the new book somewhere else and leaves this one exactly
    // as it was. Staying put shows the old book — same length, same pictures —
    // which reads as the edit having done nothing at all.
    final repository = _ReplanRepository();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('Book chat for project-1'), findsOneWidget);

    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(repository.appliedProposalIds, ['proposal-1']);
    expect(find.text('Book chat for project-copy'), findsOneWidget);
  });

  testWidgets('an ordinary edit stays on the book being edited', (tester) async {
    final repository = _ReplanRepository(replanCopyProjectId: null);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();

    expect(find.text('Book chat for project-1'), findsOneWidget);
  });
}

Widget _app(_ReplanRepository repository) {
  final router = GoRouter(
    initialLocation: '/projects/project-1/chat',
    routes: [
      GoRoute(
        path: '/projects/:id/chat',
        builder: (context, state) {
          final id = state.pathParameters['id']!;
          return Column(
            children: [
              Expanded(child: ProjectChatScreen(projectId: id)),
              // Names the project the chat is pointed at, so the test can tell
              // which book the user ended up on.
              Material(child: Text('Book chat for $id')),
            ],
          );
        },
      ),
    ],
  );
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp.router(routerConfig: router),
  );
}

/// A chat sitting on a priced book-replan proposal that is waiting on Apply.
class _ReplanRepository implements ProjectsRepository {
  _ReplanRepository({this.replanCopyProjectId = 'project-copy'});

  final String? replanCopyProjectId;
  final appliedProposalIds = <String>[];
  final statusController = StreamController<MobileProjectStatus>.broadcast();

  MobileProjectChatMessage _message({
    required String id,
    required String? parentId,
    required String role,
    required String content,
    Map<String, dynamic> metadata = const {},
  }) {
    return MobileProjectChatMessage(
      id: id,
      projectId: 'project-1',
      parentId: parentId,
      role: role,
      content: content,
      metadata: metadata,
      createdAt: DateTime.utc(2026, 8, 5),
    );
  }

  MobileProjectChat _chat() {
    return MobileProjectChat(
      messages: [
        _message(
          id: 'm0',
          parentId: null,
          role: 'user',
          content: 'make it 3 pages without illustrations',
        ),
        _message(
          id: 'm1',
          parentId: 'm0',
          role: 'assistant',
          content: 'Rebuild as a new 3-page copy without illustrations. '
              'Tap Apply to confirm, or Cancel to drop it.',
          metadata: const {
            'pendingEdit': {'clarification': 'confirm'},
            'editProposal': {
              'id': 'proposal-1',
              'kind': 'book_replan',
              'scope': 'all_pages',
              'credits': 644,
              'summary': 'Rebuild as a new 3-page copy without illustrations',
              'affectedPageIndexes': <int>[],
            },
          },
        ),
      ],
      operations: const [],
      openProposalId: 'proposal-1',
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
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    appliedProposalIds.add(proposalId);
    final chat = _chat();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: _message(
        id: 'm2',
        parentId: 'm1',
        role: 'assistant',
        content: 'I created a new copy and I’ll rebuild the plan and book '
            'there. This book stays unchanged.',
        metadata: {
          if (replanCopyProjectId != null)
            'replanCopy': {
              'sourceProjectId': 'project-1',
              'targetProjectId': replanCopyProjectId,
            },
        },
      ),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) =>
      statusController.stream;

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
