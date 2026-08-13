import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/credit_cost_badge.dart';
import 'package:tomeza/features/projects/presentation/edit_proposal_card.dart';

import 'creation_chat_harness.dart';
import 'creation_chat_fakes.dart';

// The finished-book turn in the creation chat: an edit's card belongs under the
// reply that announced it, and a spent proposal stops asking to be applied.

const _proposalText =
    'Replace the illustration on page 1. Tap Apply to confirm, or Cancel to '
    'drop it.';
const _queuedReply =
    'I’m creating that illustration now and replacing the one on page 1, then '
    'I’ll refresh the exports.';

/// Scoped to the proposal card: the user's own reply in this turn is the word
/// "Apply", so a bare text finder matches the transcript as well as the button.
Finder _proposalButton(String label) => find.descendant(
  of: find.byType(EditProposalCard),
  matching: find.text(label),
);

MobileProjectChatMessage _message({
  required String id,
  required String? parentId,
  required String role,
  required String content,
  String? operationId,
  Map<String, dynamic> metadata = const {},
  int minute = 0,
}) {
  return MobileProjectChatMessage(
    id: id,
    projectId: 'project-1',
    parentId: parentId,
    role: role,
    content: content,
    operationId: operationId,
    metadata: metadata,
    createdAt: DateTime.utc(2026, 8, 13, 21, 59, minute),
  );
}

/// The exact turn from the bug report: a priced proposal, the Apply that took
/// it, the reply announcing the work, and the operation behind it.
void _seedAppliedIllustrationEdit(
  PlanProjectsRepository projects, {
  required String status,
  String? anchorMessageId = 'chat-reply',
  bool proposalStillOpen = false,
}) {
  projects.chatMessages.addAll([
    _message(
      id: 'chat-ask',
      parentId: null,
      role: 'user',
      content: 'make the illustration on page 1 more aggressive',
    ),
    _message(
      id: 'chat-proposal',
      parentId: 'chat-ask',
      role: 'assistant',
      content: _proposalText,
      minute: 1,
      metadata: const {
        'pendingEdit': {'clarification': 'confirm'},
        'editProposal': {
          'id': 'proposal-1',
          'kind': 'add_image',
          'scope': 'single_page',
          'credits': 45,
          'summary': 'Replace the illustration on page 1',
          'affectedPageIndexes': <int>[1],
        },
      },
    ),
    _message(
      id: 'chat-apply',
      parentId: 'chat-proposal',
      role: 'user',
      content: 'Apply',
      minute: 2,
      metadata: const {'proposalAction': 'apply', 'proposalId': 'proposal-1'},
    ),
    _message(
      id: 'chat-reply',
      parentId: 'chat-apply',
      role: 'assistant',
      content: _queuedReply,
      operationId: 'op-1',
      minute: 3,
      metadata: const {'creditsCharged': 45},
    ),
  ]);
  projects.openProposalId = proposalStillOpen ? 'proposal-1' : null;
  projects.chatOperations.add(
    MobileBookEditOperation(
      id: 'op-1',
      projectId: 'project-1',
      kind: 'add_image',
      status: status,
      affectedPageIndexes: const [1],
      creditsCharged: 45,
      currentAction: status == 'applied'
          ? 'Illustration replaced on page 1.'
          : 'Creating your illustration.',
      canUndo: status == 'applied',
      changesAvailable: status == 'applied',
      anchorMessageId: anchorMessageId,
      // Written before the reply that announces it, which is what used to sort
      // the card above that reply.
      createdAt: DateTime.utc(2026, 8, 13, 21, 59, 1),
    ),
  );
}

Future<PlanProjectsRepository> _pumpFinishedBook(
  WidgetTester tester, {
  required String status,
  String? anchorMessageId = 'chat-reply',
  bool proposalStillOpen = false,
}) async {
  final creation = ScriptedCreationRepository(
    sessions: [
      chatSession(
        draftId: 'draft-done',
        title: 'Completed book',
        status: 'COMPLETED',
        createdProjectId: 'project-1',
        outputs: [
          creationOutput(projectId: 'project-1', title: planTitle, sequence: 1),
        ],
      ),
    ],
  );
  creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
  final projects = PlanProjectsRepository(
    project: plannedProject(status: 'complete', plan: approvedPlan()),
  );
  _seedAppliedIllustrationEdit(
    projects,
    status: status,
    anchorMessageId: anchorMessageId,
    proposalStillOpen: proposalStillOpen,
  );

  await tester.pumpWidget(
    app(creation: creation, projects: projects, draftId: 'draft-done'),
  );
  // Plain pumps: a running card spins forever, so settling would never return.
  await tester.pump();
  for (var frame = 0; frame < 6; frame++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  return projects;
}

void main() {
  testWidgets('an applied edit lands under the reply that announced it', (
    tester,
  ) async {
    // The transcript used to end on "I'm creating that illustration now…" with
    // the finished card above it, so the turn read backwards and the last word
    // was a promise that had already been kept.
    await _pumpFinishedBook(tester, status: 'applied');

    final reply = tester.getTopLeft(bubbleText(_queuedReply)).dy;
    final applied = tester
        .getTopLeft(bubbleText('Illustration replaced on page 1.'))
        .dy;
    expect(applied, greaterThan(reply));

    // And it is the card that carries the follow-ups.
    expect(bubbleText('Open book'), findsOneWidget);
    expect(bubbleText('See changes'), findsOneWidget);
    expect(bubbleText('Undo'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a card still anchored to the Apply row follows the reply too', (
    tester,
  ) async {
    // What the server returns until it stamps the reply onto the operation —
    // and forever, if it dies in that window.
    await _pumpFinishedBook(
      tester,
      status: 'applied',
      anchorMessageId: 'chat-apply',
    );

    final reply = tester.getTopLeft(bubbleText(_queuedReply)).dy;
    final applied = tester
        .getTopLeft(bubbleText('Illustration replaced on page 1.'))
        .dy;
    expect(applied, greaterThan(reply));

    await tester.teardownScreen();
  });

  testWidgets('the charge is stated once, on the card', (tester) async {
    // The proposal above keeps its own badge, but that one is a quote. Only
    // the card says the 45 credits were actually taken.
    await _pumpFinishedBook(tester, status: 'applied');

    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is CreditCostBadge &&
            widget.credits == 45 &&
            widget.kind == CreditCostKind.charged,
      ),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('work still running keeps its live card under the reply', (
    tester,
  ) async {
    await _pumpFinishedBook(tester, status: 'queued');

    final reply = tester.getTopLeft(bubbleText(_queuedReply)).dy;
    final running = tester
        .getTopLeft(bubbleText('Creating your illustration.'))
        .dy;
    expect(running, greaterThan(reply));
    expect(bubbleText('Undo'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('a spent proposal stops offering Apply', (tester) async {
    await _pumpFinishedBook(tester, status: 'applied');

    // The card stays as history — it just no longer asks to be acted on.
    expect(bubbleText(_proposalText), findsOneWidget);
    expect(_proposalButton('Apply'), findsNothing);
    expect(_proposalButton('Cancel'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('a proposal the server still holds open keeps its buttons', (
    tester,
  ) async {
    await _pumpFinishedBook(tester, status: 'applied', proposalStillOpen: true);

    expect(_proposalButton('Apply'), findsOneWidget);
    expect(_proposalButton('Cancel'), findsOneWidget);

    await tester.teardownScreen();
  });
}
