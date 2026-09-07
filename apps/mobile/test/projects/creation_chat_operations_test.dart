import 'package:flutter/material.dart';
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

Future<PlanProjectsRepository> _pumpCompletedApprovedBook(
  WidgetTester tester, {
  required void Function(PlanProjectsRepository projects) seed,
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
  seed(projects);

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

Future<PlanProjectsRepository> _pumpFinishedBook(
  WidgetTester tester, {
  required String status,
  String? anchorMessageId = 'chat-reply',
  bool proposalStillOpen = false,
}) {
  return _pumpCompletedApprovedBook(
    tester,
    seed: (projects) => _seedAppliedIllustrationEdit(
      projects,
      status: status,
      anchorMessageId: anchorMessageId,
      proposalStillOpen: proposalStillOpen,
    ),
  );
}

Future<PlanProjectsRepository> _pumpShortAppliedBook(
  WidgetTester tester, {
  bool canRedo = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(400, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  return _pumpCompletedApprovedBook(
    tester,
    seed: (projects) {
      projects.status = projectStatus(
        status: 'complete',
        progressPercent: 100,
        currentAction: '',
      );
      projects.chatMessages.addAll([
        _message(
          id: 'chat-ask',
          parentId: null,
          role: 'user',
          content: 'make the illustration on page 1 more aggressive',
        ),
        _message(
          id: 'chat-reply',
          parentId: 'chat-ask',
          role: 'assistant',
          content: _queuedReply,
          operationId: 'op-1',
          minute: 1,
        ),
      ]);
      projects.chatOperations.add(
        MobileBookEditOperation(
          id: 'op-1',
          projectId: 'project-1',
          kind: 'add_image',
          status: 'applied',
          affectedPageIndexes: const [1],
          creditsCharged: 45,
          currentAction: 'Illustration replaced on page 1.',
          canUndo: !canRedo,
          canRedo: canRedo,
          changesAvailable: true,
          anchorMessageId: 'chat-reply',
          createdAt: DateTime.utc(2026, 8, 13, 21, 59, 1),
        ),
      );
    },
  );
}

class _AppliedPageRewriteRetryRepository extends PlanProjectsRepository {
  _AppliedPageRewriteRetryRepository()
    : super(
        project: plannedProject(status: 'complete', plan: approvedPlan()),
      );

  final retriedOperationIds = <String>[];

  @override
  Future<MobileBookEditOperation> retryOperation({
    required String projectId,
    required String operationId,
    String? requestId,
    String? retryToken,
  }) async {
    retriedOperationIds.add(operationId);
    final index = chatOperations.indexWhere(
      (operation) => operation.id == operationId,
    );
    final failed = chatOperations[index];
    final applied = MobileBookEditOperation(
      id: failed.id,
      projectId: failed.projectId,
      kind: failed.kind,
      status: 'applied',
      affectedPageIndexes: failed.affectedPageIndexes,
      creditsCharged: failed.creditsCharged,
      currentAction: 'Page rewrite applied.',
      createdAt: failed.createdAt,
      appliedAt: DateTime.utc(2026, 8, 31, 14, 19),
      anchorMessageId: failed.anchorMessageId,
    );
    chatOperations[index] = applied;
    status = projectStatusFromProject(project);
    return applied;
  }
}

MobileProjectStatus _editingRebuildStatus() {
  return projectStatus(
    status: 'editing',
    statusLabel: 'Editing your book',
    progressPercent: 92,
    currentAction: 'Laying out your updated book',
    editProgress: const MobileGenerationProgress(
      percent: 92,
      detail: 'Laying out your updated book',
      steps: [
        MobileProjectStatusStep(
          key: 'export',
          label: 'Rebuilding your book',
          status: 'active',
        ),
      ],
    ),
  );
}

void _armUndoRedoRebuild(
  PlanProjectsRepository projects, {
  required String action,
  bool armNextSendStatus = true,
}) {
  projects.nextSendReplyMetadata = {
    action: {
      'operationId': 'op-1',
      'restoredPageIndexes': [1],
    },
  };
  if (armNextSendStatus) {
    projects.nextSendStatus = _editingRebuildStatus();
  }
}

Future<void> _expectRebuildThenOpenBook(
  WidgetTester tester,
  PlanProjectsRepository projects, {
  bool expectUndo = true,
}) async {
  for (var frame = 0; frame < 8; frame++) {
    await tester.pump(const Duration(milliseconds: 200));
  }

  expect(bubbleText('Laying out your updated book'), findsOneWidget);
  expect(bubbleText('Rebuilding your book'), findsOneWidget);
  expect(
    bubbleText('Open book'),
    findsNothing,
    reason: 'the previous PDF is still on disk until the compile finishes',
  );
  expect(bubbleText('See changes'), findsOneWidget);
  expect(find.text('Regenerating your book…'), findsOneWidget);
  if (expectUndo) {
    expect(find.widgetWithText(TextButton, 'Undo'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Undo'))
          .onPressed,
      isNull,
    );
  }

  projects.emitStatus(
    projectStatus(
      status: 'complete',
      progressPercent: 100,
      currentAction: '',
      updatedAt: DateTime.utc(2026, 6, 15, 13),
    ),
  );
  await tester.pump();
  await tester.pump();

  expect(bubbleText('Open book'), findsOneWidget);
  expect(bubbleText('See changes'), findsOneWidget);
  expect(find.text('Regenerating your book…'), findsNothing);
  if (expectUndo) {
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Undo'))
          .onPressed,
      isNotNull,
    );
  }
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

  testWidgets('a running page rewrite names the current page and how far '
      'through the batch it is', (tester) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
          outputs: [
            creationOutput(
              projectId: 'project-1',
              title: planTitle,
              sequence: 1,
            ),
          ],
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'editing', plan: approvedPlan()),
      status: projectStatus(
        status: 'editing',
        statusLabel: 'Editing your book',
        progressPercent: 58,
        currentAction: 'Rewriting page 8 (2 of 11)',
        editProgress: const MobileGenerationProgress(
          percent: 58,
          detail: 'Rewriting page 8 (2 of 11)',
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Reading your book',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'snapshot',
              label: 'Saving a version to undo',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'apply',
              label: 'Making your changes',
              status: 'active',
              detail: '1 of 11 pages',
            ),
            MobileProjectStatusStep(
              key: 'export',
              label: 'Rebuilding your book',
              status: 'pending',
            ),
          ],
        ),
      ),
    );
    projects.chatMessages.addAll([
      _message(
        id: 'chat-ask',
        parentId: null,
        role: 'user',
        content: 'Tighten the middle chapters.',
      ),
      _message(
        id: 'chat-reply',
        parentId: 'chat-ask',
        role: 'assistant',
        content: 'Rewriting those pages now.',
        operationId: 'op-rewrite',
        minute: 1,
      ),
    ]);
    projects.chatOperations.add(
      MobileBookEditOperation(
        id: 'op-rewrite',
        projectId: 'project-1',
        kind: 'page_rewrite',
        status: 'active',
        affectedPageIndexes: const [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        creditsCharged: 135,
        currentAction: 'Rewriting 11 pages.',
        anchorMessageId: 'chat-reply',
        createdAt: DateTime.utc(2026, 8, 13, 21, 59, 1),
      ),
    );

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pump();
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(bubbleText('Rewriting 11 pages.'), findsOneWidget);
    expect(bubbleText('Rewriting page 8 (2 of 11)'), findsOneWidget);
    expect(bubbleText('58%'), findsOneWidget);
    expect(bubbleText('Making your changes'), findsOneWidget);
    expect(bubbleText('1 of 11 pages'), findsOneWidget);
    expect(bubbleText('Rebuilding your book'), findsOneWidget);
    // The plan-side generation bubble used to be the only progress UI, and it
    // sat next to the plan — out of view of the reply this card belongs under.
    expect(find.text('120/120 pages'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets(
    'a finished page rewrite retry does not show plan revision work',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Completed book',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
            outputs: [
              creationOutput(
                projectId: 'project-1',
                title: planTitle,
                sequence: 1,
              ),
            ],
          ),
        ],
      );
      creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
      final projects = _AppliedPageRewriteRetryRepository();
      projects.chatOperations.add(
        MobileBookEditOperation(
          id: 'rewrite-1',
          projectId: 'project-1',
          kind: 'page_rewrite',
          status: 'failed',
          affectedPageIndexes: const [8],
          creditsCharged: 80,
          currentAction: 'Edit failed.',
          error: 'The rewrite could not be verified.',
          retryAvailable: true,
          recoveryQuote: const MobileGenerationRecoveryQuote(
            retryToken: 'retry-token',
            credits: 80,
            requiresConfirmation: true,
          ),
          createdAt: DateTime.utc(2026, 8, 31, 14, 16),
        ),
      );

      await tester.pumpWidget(
        app(creation: creation, projects: projects, draftId: 'draft-done'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry update'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry for 80'));
      // The pre-fix state left a four-second poll running forever, so settling
      // would hide the wrong footer behind a timeout instead of detecting it.
      await tester.pump();
      for (var frame = 0; frame < 6; frame++) {
        await tester.pump(const Duration(milliseconds: 200));
      }

      expect(projects.retriedOperationIds, ['rewrite-1']);
      expect(find.text('Revising your book plan'), findsNothing);
      expect(find.text('Ask for an edit to this book…'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

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

  testWidgets(
    'a typed Undo shows rebuild progress on the latest turn',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'undo');
      await tester.enterText(find.byType(TextField).last, 'Undo');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await _expectRebuildThenOpenBook(tester, projects);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a typed Redo shows rebuild progress on the latest turn',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'redo');
      await tester.enterText(find.byType(TextField).last, 'Redo');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await _expectRebuildThenOpenBook(tester, projects);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a card Undo shows rebuild progress on the latest turn',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'undo');
      final undo = find.text('Undo');
      await tester.ensureVisible(undo);
      await tester.tap(undo);
      await _expectRebuildThenOpenBook(tester, projects);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a card Redo shows rebuild progress on the latest turn',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester, canRedo: true);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'redo');
      final redo = find.text('Redo');
      await tester.ensureVisible(redo);
      await tester.tap(redo);
      await _expectRebuildThenOpenBook(tester, projects, expectUndo: false);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a typed Undo sits at 0% until live rebuild progress arrives',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'undo', armNextSendStatus: false);
      await tester.enterText(find.byType(TextField).last, 'Undo');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 200));
      }

      expect(find.text('0%'), findsOneWidget);
      expect(bubbleText('Rebuilding your book…'), findsOneWidget);
      expect(
        find.text('100%'),
        findsNothing,
        reason:
            'the pre-undo COMPLETE snapshot is still on the stream; its '
            'progressPercent is the previous book, not this rebuild',
      );
      expect(bubbleText('Open book'), findsNothing);

      projects.emitStatus(_editingRebuildStatus());
      await tester.pump();
      await tester.pump();

      expect(find.text('92%'), findsOneWidget);
      expect(bubbleText('Laying out your updated book'), findsOneWidget);
      expect(bubbleText('Open book'), findsNothing);

      projects.emitStatus(
        projectStatus(
          status: 'complete',
          progressPercent: 100,
          currentAction: '',
          updatedAt: DateTime.utc(2026, 6, 15, 13),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(bubbleText('Open book'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a card Undo sits at 0% until live rebuild progress arrives',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      expect(bubbleText('Open book'), findsOneWidget);

      _armUndoRedoRebuild(projects, action: 'undo', armNextSendStatus: false);
      final undo = find.text('Undo');
      await tester.ensureVisible(undo);
      await tester.tap(undo);
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 200));
      }

      expect(find.text('0%'), findsOneWidget);
      expect(bubbleText('Rebuilding your book…'), findsOneWidget);
      expect(
        find.text('100%'),
        findsNothing,
        reason:
            'the pre-undo COMPLETE snapshot is still on the stream; its '
            'progressPercent is the previous book, not this rebuild',
      );
      expect(bubbleText('Open book'), findsNothing);

      projects.emitStatus(_editingRebuildStatus());
      await tester.pump();
      await tester.pump();

      expect(find.text('92%'), findsOneWidget);
      expect(bubbleText('Laying out your updated book'), findsOneWidget);
      expect(bubbleText('Open book'), findsNothing);

      projects.emitStatus(
        projectStatus(
          status: 'complete',
          progressPercent: 100,
          currentAction: '',
          updatedAt: DateTime.utc(2026, 6, 15, 13),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(bubbleText('Open book'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a typed Undo drops the rebuild spinner when the first status is already settled',
    (tester) async {
      final projects = await _pumpShortAppliedBook(tester);
      projects.nextSendReplyMetadata = {
        'undo': {
          'operationId': 'op-1',
          'restoredPageIndexes': [1],
        },
      };
      projects.nextSendStatus = projectStatus(
        status: 'complete',
        progressPercent: 100,
        currentAction: '',
        updatedAt: DateTime.utc(2026, 6, 15, 13),
      );

      await tester.enterText(find.byType(TextField).last, 'Undo');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 200));
      }

      expect(projects.chatMessages.last.queuedRebuildAfterUndoRedo, isTrue);
      expect(
        bubbleText('Rebuilding your book…'),
        findsNothing,
        reason:
            'the compile already finished before the first status tick; '
            'keeping the handoff would leave Regenerating up',
      );
      expect(find.text('Regenerating your book…'), findsNothing);
      expect(bubbleText('Open book'), findsOneWidget);
      expect(bubbleText('See changes'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Undo'))
            .onPressed,
        isNotNull,
      );

      await tester.teardownScreen();
    },
  );
}
