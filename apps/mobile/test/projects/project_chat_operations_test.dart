import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/credit_cost_badge.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'project_chat_harness_optimistic.dart';

void main() {
  testWidgets('a running edit reports progress and lands the result on its own', (
    tester,
  ) async {
    // Applying hands the work to the worker. Before this the chat went silent:
    // no progress, and the finished text only appeared on a manual refresh.
    final repository = ScriptedProjectsRepository()..fillWithManyMessages();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();
    final fetchesBefore = repository.chatFetches.length;

    repository.emitStatus(
      status: 'editing',
      progressPercent: 40,
      action: 'Rewriting page 3',
      editProgress: editProgress(40, active: 'Making your changes'),
    );
    // Not pumpAndSettle: the progress card spins for as long as the work runs.
    // The follow-scroll needs a couple of frames — the card sizes itself in the
    // first, and the scroll animates after that.
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('Rewriting page 3'), findsOneWidget);
    // The steps say which part of the edit is running, so the card keeps
    // reading as progress even when the headline holds still.
    expect(find.text('Making your changes'), findsOneWidget);
    expect(find.text('Rebuilding your book'), findsOneWidget);
    expect(
      find.text('3 of 12 pages'),
      findsNothing,
      reason: 'that is the whole book, not the pages this edit touches',
    );
    expect(
      scrollPosition(tester).pixels,
      scrollPosition(tester).maxScrollExtent,
      reason: 'progress must be in view, not above the fold',
    );

    // Work finishes: the transcript refreshes without the user asking.
    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(find.text('Rewriting page 3'), findsNothing);
    expect(repository.chatFetches.length, greaterThan(fetchesBefore));
    expect(
      scrollPosition(tester).pixels,
      scrollPosition(tester).maxScrollExtent,
    );
  });

  testWidgets('the running step says how far through it is', (tester) async {
    // Rewriting is the long step of an edit. The headline names the page, and
    // the step's own count is what keeps reading as progress across the pages
    // either side of it — without it the card holds still for minutes.
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    repository.emitStatus(
      status: 'editing',
      progressPercent: 58,
      action: 'Reading back page 8',
      editProgress: editProgress(
        58,
        active: 'Making your changes',
        activeDetail: '1 of 3 pages',
      ),
    );
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('Reading back page 8'), findsOneWidget);
    expect(find.text('1 of 3 pages'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Making your changes. In progress. 1 of 3 pages.'),
      findsOneWidget,
      reason: 'a count drawn on screen has to be in the label too',
    );
  });

  testWidgets('a settled book that was never live does not refetch', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();
    final fetchesBefore = repository.chatFetches.length;

    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(repository.chatFetches.length, fetchesBefore);
  });

  testWidgets('a failed send shows a retry bubble and never clobbers text '
      'typed while waiting', (tester) async {
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    expect(find.text('Open book'), findsOneWidget);
    expect(find.text('See changes'), findsOneWidget);
  });

  testWidgets('an edit with no recorded snapshots does not offer a diff', (
    tester,
  ) async {
    // The button would open a screen with nothing on it. Older edits predate
    // snapshots, so the affordance has to follow the data.
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal(changesAvailable: false);
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    expect(find.text('Open book'), findsOneWidget);
    expect(find.text('See changes'), findsNothing);
  });

  testWidgets('every applied edit gets its own entry, not just the newest', (
    tester,
  ) async {
    // The transcript is the book's history: an edit two turns ago still has to
    // say what it did, even though only the latest one can be undone.
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal()
      ..withSecondAppliedEdit();
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository()..withOldFailedReplan();
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal();
    await tester.pumpWidget(chatApp(repository));
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
    final repository = ScriptedProjectsRepository()
      ..withAppliedEditThenPendingProposal(anchored: false);
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    final applied = tester.getTopLeft(find.text('Edit applied.')).dy;
    final proposal = tester
        .getTopLeft(
          find.text('Edit page 1. Tap Apply to confirm, or Cancel to drop it.'),
        )
        .dy;
    expect(applied, greaterThan(proposal));
  });

  testWidgets('the composer closes while the book is being rebuilt', (
    tester,
  ) async {
    // A book mid-rebuild cannot take another request — the API parks anything
    // that arrives until the job settles — so an open field was a chat that
    // looked like it was listening and then quietly ignored you.
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Also make it funnier');
    repository.emitStatus(
      status: 'editing',
      progressPercent: 30,
      action: 'Rewriting page 3',
    );
    // Not pumpAndSettle: the progress card spins for as long as the work runs.
    await tester.pump();
    await tester.pump();

    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.enabled, isFalse);
    expect(composer.decoration?.hintText, 'Regenerating your book…');
    // The half-written thought survives the lock instead of being thrown away.
    expect(composer.controller?.text, 'Also make it funnier');
    // The edit pencil goes with it: an edited message is another chat turn.
    expect(find.byTooltip('Edit message'), findsNothing);

    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();
    expect(repository.sentMessages, isEmpty);
  });

  testWidgets('the composer reopens the moment the rebuild finishes', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    repository.emitStatus(status: 'editing', progressPercent: 30);
    await tester.pump();
    await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
    await tester.enterText(find.byType(TextField), 'Now make it funnier');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pumpAndSettle();

    expect(repository.sentMessages, ['Now make it funnier']);
  });

  testWidgets('the composer is locked while the book is first generated', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    repository.emitStatus(status: 'generating', progressPercent: 30);
    await tester.pump();
    await tester.pump();

    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.enabled, isFalse);
    expect(composer.decoration?.hintText, 'Generating your book…');
    expect(find.byTooltip('Edit message'), findsNothing);

    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();
    expect(repository.sentMessages, isEmpty);
  });

  testWidgets('a failed inline edit keeps the edited text in the editor', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.editGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Edit message'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Edited but doomed');
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
