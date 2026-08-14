import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/chat_thinking_bubble.dart';

import 'project_chat_harness_optimistic.dart';

void main() {
  testWidgets('a sent message appears immediately while the request is in '
      'flight and stays after it lands', (tester) async {
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
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

  testWidgets('the assistant says it is working, and stops once the work is '
      'really running', (tester) async {
    // Routing a message takes a model call or two. Without an assistant-side
    // bubble the wait was silent: only the send button changed.
    final repository = ScriptedProjectsRepository();
    final gate = Completer<void>();
    repository.sendGates.add(gate);
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Make chapter two warmer');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pump();

    expect(find.byType(ChatThinkingBubble), findsOneWidget);
    expect(find.text('Reading your message…'), findsOneWidget);

    // Long waits say something new rather than repeating one word.
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Looking through your book…'), findsOneWidget);

    // Once the worker has the job, the progress card is the better signal and
    // two spinners would read as two jobs.
    repository.emitStatus(
      status: 'editing',
      progressPercent: 20,
      action: 'Reading your book',
    );
    await tester.pump();
    await tester.pump();
    expect(find.byType(ChatThinkingBubble), findsNothing);

    // Not pumpAndSettle: the progress card spins for as long as the work runs.
    gate.complete();
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(find.byType(ChatThinkingBubble), findsNothing);
    expect(find.text('Reply about Make chapter two warmer'), findsOneWidget);
  });

  testWidgets('an edit that finishes between status ticks still lands on its '
      'own', (tester) async {
    // The falling edge is what pulls the finished result in. A short edit can
    // start and finish without the client ever seeing a live tick, which used
    // to strand the result behind a manual pull-to-refresh.
    final repository = ScriptedProjectsRepository()
      ..sendOperation = queuedOperation();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();
    final fetchesBefore = repository.chatFetches.length;

    await tester.enterText(find.byType(TextField), 'Make chapter two warmer');
    await tester.tap(find.byIcon(Icons.send_outlined));
    await tester.pumpAndSettle();

    repository.emitStatus(status: 'complete', progressPercent: 100);
    await tester.pumpAndSettle();

    expect(repository.chatFetches.length, greaterThan(fetchesBefore + 1));
  });

  testWidgets(
    'a message handed in on open is sent without the caller waiting',
    (tester) async {
      // The reader pushes the chat and hands over the edit rather than awaiting
      // the request itself, so acting on a passage opens the chat immediately.
      final repository = ScriptedProjectsRepository();
      final gate = Completer<void>();
      repository.sendGates.add(gate);

      await tester.pumpWidget(
        chatApp(
          repository,
          initialMessage: 'On page 3, rewrite this passage: "x".',
        ),
      );
      await tester.pump();
      await tester.pump();

      // On screen as a pending bubble before the server has answered.
      expect(
        find.text('On page 3, rewrite this passage: "x".'),
        findsOneWidget,
      );
      expect(repository.sentMessages, [
        'On page 3, rewrite this passage: "x".',
      ]);

      gate.complete();
      await tester.pumpAndSettle();

      expect(
        find.text('Reply about On page 3, rewrite this passage: "x".'),
        findsOneWidget,
      );
    },
  );

  testWidgets('a handed-in reader message carries its reader context', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(
      chatApp(
        repository,
        initialMessage: 'On page 12, rewrite this passage: "x".',
        initialReaderContext: const {'pageIndex': 4, 'pdfPage': 12},
      ),
    );
    await tester.pumpAndSettle();

    // The structured position is what the server targets by; losing it would
    // leave the visible printed number as the only — re-parsed — signal.
    expect(repository.sentReaderContexts, [
      {'pageIndex': 4, 'pdfPage': 12},
    ]);
  });

  testWidgets('an empty handed-in message sends nothing', (tester) async {
    final repository = ScriptedProjectsRepository();
    await tester.pumpWidget(chatApp(repository, initialMessage: '   '));
    await tester.pumpAndSettle();

    expect(repository.sentMessages, isEmpty);
  });

  testWidgets('the transcript opens at the newest message', (tester) async {
    final repository = ScriptedProjectsRepository()..fillWithManyMessages();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    final position = scrollPosition(tester);
    expect(
      position.pixels,
      position.maxScrollExtent,
      reason:
          'a chat that opens at the oldest message hides what just happened',
    );
    expect(position.maxScrollExtent, greaterThan(0), reason: 'needs overflow');
  });

  testWidgets('tapping the reply banner scrolls back to its message', (
    tester,
  ) async {
    final repository = ScriptedProjectsRepository()..fillWithManyMessages();
    await tester.pumpWidget(chatApp(repository));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('The newest message'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();

    final position = scrollPosition(tester);
    expect(find.byTooltip('Go to replied message'), findsOneWidget);

    // Move far enough away for the lazily built target bubble to be disposed.
    // The banner should still remember where it was in the transcript.
    position.jumpTo(position.minScrollExtent);
    await tester.pump();
    expect(position.pixels, position.minScrollExtent);

    await tester.tap(find.byTooltip('Go to replied message'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(position.pixels, greaterThan(position.maxScrollExtent * 0.8));
  });

}
