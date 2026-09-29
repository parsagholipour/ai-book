import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_proposal_card.dart';

import 'project_chat_harness_optimistic.dart';

/// A finished book with one priced proposal waiting on Apply.
class _ProposalRepository extends ScriptedProjectsRepository {
  final applyGate = Completer<void>();
  bool applied = false;
  bool cancelled = false;

  MobileProjectChat _chatWithProposal() => MobileProjectChat(
    // The server keeps reporting it open until the next refetch catches up,
    // which is exactly the window the card has to stay closed through.
    openProposalId: 'proposal-1',
    messages: [
      MobileProjectChatMessage(
        id: 'm0',
        projectId: 'project-1',
        role: 'user',
        content: 'Make page 3 warmer',
        metadata: const {},
        createdAt: DateTime.utc(2026, 6, 15),
      ),
      MobileProjectChatMessage(
        id: 'm1',
        projectId: 'project-1',
        parentId: 'm0',
        role: 'assistant',
        content: 'Rewrite page 3 so it sounds warmer.',
        metadata: const {
          'pendingEdit': {'clarification': 'confirm'},
          'editProposal': {
            'id': 'proposal-1',
            'kind': 'page_rewrite',
            'scope': 'pages',
            'credits': 80,
            'summary': 'Rewrite page 3 so it sounds warmer',
            'affectedPageIndexes': [3],
            'readerPageNumbers': [3],
          },
        },
        createdAt: DateTime.utc(2026, 6, 15, 0, 1),
      ),
    ],
    operations: const [],
  );

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async => _chatWithProposal();

  @override
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    await applyGate.future;
    applied = true;
    final chat = _chatWithProposal();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: chat.messages.last,
      operation: queuedOperation(),
    );
  }

  @override
  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    cancelled = true;
    final chat = _chatWithProposal();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: chat.messages.last,
    );
  }
}

Finder get _apply => find.byKey(const ValueKey('edit-proposal-apply'));

void main() {
  testWidgets('Apply shows the edit starting, then the card settles as Applied '
      'even before the transcript catches up', (tester) async {
    final repository = _ProposalRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    expect(_apply, findsOneWidget);
    expect(find.text('Starting your edit…'), findsNothing);

    await tester.tap(_apply);
    await tester.pump();
    // Plain pumps: the working sparkle turns until the request returns.
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Starting your edit…'), findsOneWidget);
    expect(_apply, findsNothing);

    repository.applyGate.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(repository.applied, isTrue);
    expect(find.text('Starting your edit…'), findsNothing);
    expect(_apply, findsNothing);
    expect(
      find.descendant(
        of: find.byType(EditProposalCard),
        matching: find.text('Applied'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('Cancel closes the card as Cancelled', (tester) async {
    final repository = _ProposalRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('edit-proposal-cancel')));
    await tester.pumpAndSettle();

    expect(repository.cancelled, isTrue);
    expect(_apply, findsNothing);
    expect(
      find.descendant(
        of: find.byType(EditProposalCard),
        matching: find.text('Cancelled'),
      ),
      findsOneWidget,
    );
  });
}
