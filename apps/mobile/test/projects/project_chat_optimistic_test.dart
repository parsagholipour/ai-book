import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/credit_cost_badge.dart';
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

  testWidgets('a message handed in on open is sent without the caller waiting', (
    tester,
  ) async {
    // The reader pushes the chat and hands over the edit rather than awaiting
    // the request itself, so acting on a passage opens the chat immediately.
    final repository = _ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);

    await tester.pumpWidget(
      _app(repository, initialMessage: 'On page 3, rewrite this passage: "x".'),
    );
    await tester.pump();
    await tester.pump();

    // On screen as a pending bubble before the server has answered.
    expect(
      find.text('On page 3, rewrite this passage: "x".'),
      findsOneWidget,
    );
    expect(repository.sentMessages, ['On page 3, rewrite this passage: "x".']);

    gate.complete();
    await tester.pumpAndSettle();

    expect(
      find.text('Reply about On page 3, rewrite this passage: "x".'),
      findsOneWidget,
    );
  });

  testWidgets('an empty handed-in message sends nothing', (tester) async {
    final repository = _ScriptedProjectsRepository();
    await tester.pumpWidget(_app(repository, initialMessage: '   '));
    await tester.pumpAndSettle();

    expect(repository.sentMessages, isEmpty);
  });

  testWidgets('the transcript opens at the newest message', (tester) async {
    final repository = _ScriptedProjectsRepository()..fillWithManyMessages();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    final position = scrollPosition(tester);
    expect(
      position.pixels,
      position.maxScrollExtent,
      reason: 'a chat that opens at the oldest message hides what just happened',
    );
    expect(position.maxScrollExtent, greaterThan(0), reason: 'needs overflow');
  });

  testWidgets('a running edit reports progress and lands the result on its own', (
    tester,
  ) async {
    // Applying hands the work to the worker. Before this the chat went silent:
    // no progress, and the finished text only appeared on a manual refresh.
    final repository = _ScriptedProjectsRepository()..fillWithManyMessages();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();
    final fetchesBefore = repository.chatFetches.length;

    repository.emitStatus(
      status: 'editing',
      progressPercent: 40,
      action: 'Rewriting page 3',
    );
    // Not pumpAndSettle: the progress card spins for as long as the work runs.
    // The follow-scroll needs a couple of frames — the card sizes itself in the
    // first, and the scroll animates after that.
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('Rewriting page 3'), findsOneWidget);
    expect(find.text('3 of 12 pages'), findsOneWidget);
    expect(scrollPosition(tester).pixels, scrollPosition(tester).maxScrollExtent,
        reason: 'progress must be in view, not above the fold');

    // Work finishes: the transcript refreshes without the user asking.
    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(find.text('Rewriting page 3'), findsNothing);
    expect(repository.chatFetches.length, greaterThan(fetchesBefore));
    expect(scrollPosition(tester).pixels, scrollPosition(tester).maxScrollExtent);
  });

  testWidgets('a settled book that was never live does not refetch', (
    tester,
  ) async {
    final repository = _ScriptedProjectsRepository();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();
    final fetchesBefore = repository.chatFetches.length;

    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(repository.chatFetches.length, fetchesBefore);
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

  testWidgets('an applied edit stays with the turn that caused it instead of '
      'trailing a newer proposal', (tester) async {
    // An applied edit keeps its Undo for several turns. Rendered at the end of
    // the transcript it landed under a proposal still waiting on Apply, so the
    // untouched proposal looked applied and billed at the older edit's price.
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    final applied = tester.getTopLeft(find.text('Edit applied.')).dy;
    final request = tester
        .getTopLeft(find.text('On page 1, replace "night" with "day".'))
        .dy;
    final proposal = tester
        .getTopLeft(
          find.text('Edit page 1. Tap Apply to confirm, or Cancel to drop it.'),
        )
        .dy;

    expect(find.text('Undo'), findsOneWidget);
    expect(
      applied,
      lessThan(request),
      reason: 'the applied edit belongs to the turn before the new request',
    );
    expect(applied, lessThan(proposal));
  });

  testWidgets('an applied edit offers the book and its own diff', (
    tester,
  ) async {
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('Open book'), findsOneWidget);
    expect(find.text('See changes'), findsOneWidget);
  });

  testWidgets('an edit with no recorded snapshots does not offer a diff', (
    tester,
  ) async {
    // The button would open a screen with nothing on it. Older edits predate
    // snapshots, so the affordance has to follow the data.
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal(changesAvailable: false);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('Open book'), findsOneWidget);
    expect(find.text('See changes'), findsNothing);
  });

  testWidgets('every applied edit gets its own entry, not just the newest', (
    tester,
  ) async {
    // The transcript is the book's history: an edit two turns ago still has to
    // say what it did, even though only the latest one can be undone.
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal()
      ..withSecondAppliedEdit();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('Edit applied.'), findsNWidgets(2));
    expect(find.text('See changes'), findsNWidgets(2));
    // Undo belongs to the newest undoable edit alone.
    expect(find.text('Undo'), findsOneWidget);
  });

  testWidgets('an old failure stays on its own turn and says the credits came '
      'back', (tester) async {
    // A failed replan from weeks ago rendered under a fresh, untouched proposal
    // reads as "the thing you are about to approve failed and cost you 705
    // credits" — when nothing was approved and the credits were refunded.
    final repository = _ScriptedProjectsRepository()..withOldFailedReplan();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    final failure = tester.getTopLeft(find.text('Edit failed.')).dy;
    final proposal = tester
        .getTopLeft(
          find.text('Edit page 2. Tap Apply to confirm, or Cancel to drop it.'),
        )
        .dy;

    expect(failure, lessThan(proposal));
    final refund = tester.widget<CreditCostBadge>(
      find.byWidgetPredicate(
        (widget) => widget is CreditCostBadge && widget.credits == 705,
      ),
    );
    expect(refund.kind, CreditCostKind.refunded);
  });

  testWidgets('the credit badge explains the charge instead of announcing it '
      'in the reply', (tester) async {
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    // The applied edit's charge is stated once — on its operation card, not
    // also on the reply that queued it.
    final charge = find.byWidgetPredicate(
      (widget) => widget is CreditCostBadge && widget.credits == 80,
    );
    expect(charge, findsOneWidget);

    await tester.tap(charge);
    await tester.pumpAndSettle();

    expect(find.text('80 credits'), findsOneWidget);
    expect(find.text('Credits pay for the writing'), findsOneWidget);
    expect(find.text('Failed updates are refunded'), findsOneWidget);
  });

  testWidgets('an operation with no anchor still renders at the end', (
    tester,
  ) async {
    final repository = _ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal(anchored: false);
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    final applied = tester.getTopLeft(find.text('Edit applied.')).dy;
    final proposal = tester
        .getTopLeft(
          find.text('Edit page 1. Tap Apply to confirm, or Cancel to drop it.'),
        )
        .dy;
    expect(applied, greaterThan(proposal));
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

ScrollPosition scrollPosition(WidgetTester tester) {
  return tester
      .widget<Scrollable>(find.byType(Scrollable).first)
      .controller!
      .position;
}

Widget _app(
  _ScriptedProjectsRepository repository, {
  String? initialMessage,
}) {
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp(
      home: ProjectChatScreen(
        projectId: 'project-1',
        initialMessage: initialMessage,
      ),
    ),
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
  final sentMessages = <String>[];
  final chatFetches = <String>[];
  final statusController = StreamController<MobileProjectStatus>.broadcast();
  MobileProjectChatSendResult Function()? applyResult;

  /// Pushes a status the screen's live tracker will react to.
  void emitStatus({required String status, int progressPercent = 0, String action = ''}) {
    statusController.add(
      MobileProjectStatus(
        projectId: 'project-1',
        status: status,
        statusLabel: status,
        progressPercent: progressPercent,
        currentAction: action,
        retryAvailable: false,
        steps: const [],
        pageProgress: const MobilePageProgress(completed: 3, target: 12),
        imageCount: 0,
        exports: const MobileExportSet(
          pdf: MobileExportAvailability(
            format: 'pdf',
            available: false,
            unlocked: true,
            creditsRequired: 0,
            downloadUrl: '',
            filename: 'book.pdf',
            contentType: 'application/pdf',
          ),
          epub: MobileExportAvailability(
            format: 'epub',
            available: false,
            unlocked: true,
            creditsRequired: 0,
            downloadUrl: '',
            filename: 'book.epub',
            contentType: 'application/epub+zip',
          ),
        ),
        updatedAt: DateTime.utc(2026, 6, 15),
      ),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) =>
      statusController.stream;
  final editRequestIds = <String?>[];

  final operations = <MobileBookEditOperation>[];

  /// An edit that was applied a turn ago, followed by a fresh request whose
  /// priced proposal is still waiting on Apply.
  void withAppliedEditThenPendingProposal({
    bool anchored = true,
    bool changesAvailable = true,
  }) {
    _contents
      ..add((role: 'user', content: 'Apply'))
      ..add((
        role: 'assistant',
        content: 'I’ll rewrite page 1 and refresh the exports.',
      ))
      ..add((role: 'user', content: 'On page 1, replace "night" with "day".'))
      ..add((
        role: 'assistant',
        content: 'Edit page 1. Tap Apply to confirm, or Cancel to drop it.',
      ));
    operations.add(
      MobileBookEditOperation(
        id: 'op-1',
        projectId: 'project-1',
        kind: 'page_rewrite',
        status: 'applied',
        affectedPageIndexes: const [1],
        creditsCharged: 80,
        currentAction: 'Edit applied.',
        createdAt: DateTime.utc(2026, 6, 15, 1),
        anchorMessageId: anchored ? 'm3' : null,
        canUndo: true,
        changesAvailable: changesAvailable,
      ),
    );
  }

  /// A book-replan that failed weeks ago, then a fresh page edit awaiting Apply.
  void withOldFailedReplan() {
    _contents
      ..add((role: 'user', content: 'Now regenerate it in Persian'))
      ..add((
        role: 'assistant',
        content: 'I created a new Persian copy and I\u2019ll rebuild the plan '
            'and book there.',
      ))
      ..add((role: 'user', content: 'On page 2, replace "Bunny" with "cute Bunny".'))
      ..add((
        role: 'assistant',
        content: 'Edit page 2. Tap Apply to confirm, or Cancel to drop it.',
      ));
    operations.add(
      MobileBookEditOperation(
        id: 'op-replan',
        projectId: 'project-1',
        kind: 'book_replan',
        status: 'failed',
        affectedPageIndexes: const [],
        creditsCharged: 705,
        currentAction: 'Edit failed.',
        createdAt: DateTime.utc(2026, 7, 5),
        anchorMessageId: 'm3',
        creditsRefunded: true,
      ),
    );
  }

  /// An earlier applied edit, superseded for undo by the newer one.
  void withSecondAppliedEdit() {
    operations.add(
      MobileBookEditOperation(
        id: 'op-0',
        projectId: 'project-1',
        kind: 'local_patch',
        status: 'applied',
        affectedPageIndexes: const [4],
        creditsCharged: 35,
        currentAction: 'Edit applied.',
        createdAt: DateTime.utc(2026, 6, 15),
        anchorMessageId: 'm1',
        changesAvailable: true,
      ),
    );
  }

  /// Enough history that the transcript scrolls.
  void fillWithManyMessages() {
    for (var index = 0; index < 40; index++) {
      _contents.add((role: 'assistant', content: 'Earlier message $index'));
    }
    _contents.add((role: 'user', content: 'The newest message'));
  }

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
      operations: List.of(operations),
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
    chatFetches.add(id);
    return _chat();
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
  }) async {
    sendRequestIds.add(requestId);
    sentMessages.add(message);
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
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    final build = applyResult;
    if (build == null) throw UnimplementedError();
    return build();
  }

  @override
  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectChatSendResult> undoLastBookEdit({
    required String projectId,
    String? requestId,
  }) async {
    throw UnimplementedError();
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
