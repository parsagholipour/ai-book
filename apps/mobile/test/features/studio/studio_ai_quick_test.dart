import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_ai_test_harness.dart';
import 'studio_test_harness.dart';

const _text =
    'Mara climbed the stairs. The lamp was cold.\n\n'
    'Below, the harbour slept.';

FakeStudioRepository _repo({String markdown = _text}) => FakeStudioRepository(
  title: 'The Lantern Keeper',
  chapters: [
    FakeStudioChapter(
      id: 'c1',
      title: 'The Lamp',
      markdown: markdown,
      revision: 3,
    ),
  ],
);

/// Opens the writing assistant from the keyboard's toolbar.
Future<void> _openTools(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('studio-toolbar-ai')));
  await settle(tester);
}

void main() {
  testWidgets(
    'a rewrite sends the selection with the text around it, shows the '
    'change, and replaces the selection verbatim after a checkpoint',
    (tester) async {
      final repo = _repo()
        ..nextQuickAssistResult = const QuickAssistResult(
          kind: QuickAssistKind.rewrite,
          suggestions: ['The lamp had gone cold hours ago.'],
          corrections: [],
          ideas: [],
        );
      await openStudioAi(tester, repo);
      const start = 25; // "The lamp was cold."
      const end = 43;
      await selectInBody(tester, start: start, end: end);
      await _openTools(tester);
      await tester.tap(find.byKey(const ValueKey('studio-ai-preset-vivid')));
      await settle(tester, const Duration(seconds: 1));

      final request = repo.quickAssistRequests.single;
      expect(request.kind, QuickAssistKind.rewrite);
      expect(request.preset, RewritePreset.vivid);
      expect(request.selection, 'The lamp was cold.');
      expect(request.before, 'Mara climbed the stairs. ');
      expect(request.after, '\n\nBelow, the harbour slept.');
      expect(request.chapterId, 'c1');
      expect(find.text('Rewrite · More vivid'), findsOneWidget);
      expect(find.byKey(const ValueKey('studio-ai-diff')), findsOneWidget);
      await tester.tap(find.text('New text'));
      await tester.pump();
      expect(find.byKey(const ValueKey('studio-ai-plain')), findsOneWidget);

      repo.saves.clear();
      await tester.tap(find.byKey(const ValueKey('studio-ai-replace')));
      await settle(tester);
      // The version history keeps the text as it was.
      expect(repo.saves.first.checkpoint, ManuscriptSaveCheckpoint.beforeAi);
      expect(repo.saves.first.markdown, _text);
      expect(
        bodyText(tester),
        'Mara climbed the stairs. The lamp had gone cold hours ago.\n\n'
        'Below, the harbour slept.',
      );
      await settle(tester, const Duration(milliseconds: 1500));
      expect(repo.saves.last.markdown, contains('gone cold hours ago'));
      await closeStudio(tester);
    },
  );

  testWidgets('the selection menu leads with the writing assistant', (
    tester,
  ) async {
    final repo = _repo();
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 0, end: 4);
    tester.state<EditableTextState>(bodyFields().first).showToolbar();
    await settle(tester, const Duration(milliseconds: 300));

    // On a phone one item stands in for the four, so Copy stays in view.
    expect(find.text('✨ AI'), findsOneWidget);
    expect(find.text('Copy'), findsOneWidget);
    await tester.tap(find.text('✨ AI'));
    await settle(tester);
    expect(find.text('Writing assistant'), findsOneWidget);
    expect(find.text('More vivid'), findsOneWidget);
    expect(find.text('Fix spelling & grammar'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('with room, the menu names each tool, and Fix proofreads', (
    tester,
  ) async {
    final repo = _repo();
    // Wide enough for the tools by name, still one pane.
    await openStudioAi(tester, repo, size: const Size(720, 900));
    await selectInBody(tester, start: 0, end: 24);
    tester.state<EditableTextState>(bodyFields().first).showToolbar();
    await settle(tester, const Duration(milliseconds: 300));

    for (final label in ['✨ Rewrite', 'Fix', 'Illustrate', 'Ask']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    await tester.tap(find.text('Fix'));
    await settle(tester, const Duration(seconds: 1));
    expect(repo.quickAssistRequests.single.kind, QuickAssistKind.proofread);
    expect(
      repo.quickAssistRequests.single.selection,
      'Mara climbed the stairs.',
    );
    expect(find.byKey(const ValueKey('studio-ai-no-mistakes')), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets(
    'Continue writing is inserted at the cursor verbatim, and Undo takes it '
    'back',
    (tester) async {
      final repo = _repo();
      await openStudioAi(tester, repo);
      await selectInBody(tester, start: 43);
      await _openTools(tester);
      await tester.tap(find.byKey(const ValueKey('studio-ai-tool-continue')));
      await settle(tester, const Duration(seconds: 1));

      final request = repo.quickAssistRequests.single;
      expect(request.kind, QuickAssistKind.continueWriting);
      expect(request.selection, isNull);
      expect(request.before, 'Mara climbed the stairs. The lamp was cold.');
      expect(request.after, '\n\nBelow, the harbour slept.');
      expect(
        find.byKey(const ValueKey('studio-ai-continuation')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('studio-ai-insert')));
      await settle(tester);
      expect(
        bodyText(tester),
        'Mara climbed the stairs. The lamp was cold. The wind rose over the '
        'harbour.\n\nBelow, the harbour slept.',
      );
      expect(
        repo.saves.any(
          (save) => save.checkpoint == ManuscriptSaveCheckpoint.beforeAi,
        ),
        isTrue,
      );

      // The field's own undo history holds the change.
      await settle(tester, const Duration(milliseconds: 700));
      await tester.tap(find.byTooltip('Undo'));
      await tester.pump();
      expect(bodyText(tester), _text);
      await closeStudio(tester);
    },
  );

  testWidgets('proofreading applies only the fixes left ticked', (
    tester,
  ) async {
    const text = 'Mara clmbed teh stairs. The lamp was cold.';
    final repo = _repo(markdown: text)
      ..nextQuickAssistResult = const QuickAssistResult(
        kind: QuickAssistKind.proofread,
        suggestions: [],
        corrections: [
          AssistCorrection(
            find: 'clmbed',
            replace: 'climbed',
            reason: 'Spelling',
          ),
          AssistCorrection(
            find: 'teh stairs',
            replace: 'the stairs',
            reason: 'Spelling',
          ),
        ],
        ideas: [],
      );
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 0, end: 23);
    await _openTools(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-tool-proofread')));
    await settle(tester, const Duration(seconds: 1));

    expect(find.text('Apply 2 fixes'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-ai-correction-1')));
    await tester.pump();
    expect(find.text('Apply 1 fix'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-ai-apply-fixes')));
    await settle(tester);
    expect(bodyText(tester), 'Mara climbed teh stairs. The lamp was cold.');
    await closeStudio(tester);
  });

  testWidgets('every ticked fix lands, applied right to left', (tester) async {
    const text = 'Mara clmbed teh stairs. The lamp was cold.';
    final repo = _repo(markdown: text)
      ..nextQuickAssistResult = const QuickAssistResult(
        kind: QuickAssistKind.proofread,
        suggestions: [],
        corrections: [
          AssistCorrection(find: 'clmbed', replace: 'climbed', reason: ''),
          AssistCorrection(find: 'teh', replace: 'the', reason: ''),
          AssistCorrection(find: 'was cold', replace: 'was  cold', reason: ''),
        ],
        ideas: [],
      );
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 0, end: text.length);
    await _openTools(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-tool-proofread')));
    await settle(tester, const Duration(seconds: 1));
    await tester.tap(find.byKey(const ValueKey('studio-ai-apply-fixes')));
    await settle(tester);
    expect(bodyText(tester), 'Mara climbed the stairs. The lamp was  cold.');
    await closeStudio(tester);
  });

  testWidgets('an idea from What happens next? is written by Continue', (
    tester,
  ) async {
    final repo = _repo();
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 43);
    await _openTools(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-tool-brainstorm')));
    await settle(tester, const Duration(seconds: 1));
    expect(find.text('The storm'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('studio-ai-idea-1')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('studio-ai-write-idea')));
    await settle(tester, const Duration(seconds: 1));
    final second = repo.quickAssistRequests.last;
    expect(second.kind, QuickAssistKind.continueWriting);
    expect(second.instruction, 'The storm: The weather turns.');
    expect(second.before, 'Mara climbed the stairs. The lamp was cold.');
    expect(second.requestId, isNot(repo.quickAssistRequests.first.requestId));
    await tester.tap(find.byKey(const ValueKey('studio-ai-insert')));
    await settle(tester);
    expect(
      bodyText(tester),
      startsWith('Mara climbed the stairs. The lamp was cold. The wind'),
    );
    await closeStudio(tester);
  });

  testWidgets(
    'Ask about this chapter answers a question, which can be copied',
    (tester) async {
      final repo = _repo();
      await openStudioAi(tester, repo);
      await selectInBody(tester, start: 10);
      await _openTools(tester);
      await tester.tap(find.byKey(const ValueKey('studio-ai-tool-ask')));
      await settle(tester);
      expect(repo.quickAssistRequests, isEmpty);
      await tester.enterText(
        find.byKey(const ValueKey('studio-ai-question')),
        'Is the opening too slow?',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('studio-ai-ask')));
      await settle(tester, const Duration(seconds: 1));

      final request = repo.quickAssistRequests.single;
      expect(request.kind, QuickAssistKind.ask);
      expect(request.instruction, 'Is the opening too slow?');
      expect(request.selection, isNull);
      expect(find.text('It reads clearly.'), findsOneWidget);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final copy = find.byKey(const ValueKey('studio-ai-copy'));
      await tester.ensureVisible(copy);
      await tester.pump();
      await tester.tap(copy);
      await settle(tester, const Duration(milliseconds: 200));
      expect(find.text('Copied'), findsOneWidget);
      expect(copied, 'It reads clearly.');
      // Nothing in the text changed.
      expect(bodyText(tester), _text);
      await closeStudio(tester);
    },
  );

  group('when the assistant cannot answer', () {
    Future<void> runRewrite(WidgetTester tester) async {
      await selectInBody(tester, start: 25, end: 43);
      await _openTools(tester);
      await tester.tap(find.byKey(const ValueKey('studio-ai-preset-clearer')));
      await settle(tester, const Duration(seconds: 1));
    }

    testWidgets('a message limit opens the allowance, then offers another go', (
      tester,
    ) async {
      final gate = FakeStudioBillingGate(recovers: true);
      final repo = _repo()
        ..quickAssistError = const ApiException(
          code: 'MESSAGE_LIMIT_REACHED',
          message: 'Daily message limit reached.',
          statusCode: 429,
        );
      await openStudioAi(tester, repo, gate: gate);
      await runRewrite(tester);
      expect(gate.calls, contains('messageLimitReached'));
      expect(find.text('You’re all set. Try again.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('studio-ai-try-again')));
      await settle(tester, const Duration(seconds: 1));
      expect(repo.quickAssistRequests, hasLength(2));
      expect(find.byKey(const ValueKey('studio-ai-replace')), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('a credits refusal opens the paywall and says so plainly', (
      tester,
    ) async {
      final gate = FakeStudioBillingGate();
      final repo = _repo()
        ..quickAssistError = const ApiException(
          code: 'INSUFFICIENT_CREDITS',
          message: 'You need more credits for this action.',
          statusCode: 402,
        );
      await openStudioAi(tester, repo, gate: gate);
      await runRewrite(tester);
      expect(gate.calls, contains('creditsNeeded'));
      expect(find.text('You’re out of messages for now.'), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('an unavailable assistant can be tried again, same inputs', (
      tester,
    ) async {
      final repo = _repo()
        ..quickAssistError = const ApiException(
          code: 'ASSIST_UNAVAILABLE',
          message: 'Provider timed out.',
          statusCode: 503,
        );
      await openStudioAi(tester, repo);
      await runRewrite(tester);
      expect(
        find.text('The writing assistant couldn’t answer just now.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('studio-ai-try-again')));
      await settle(tester, const Duration(seconds: 1));
      final [first, second] = repo.quickAssistRequests;
      expect(second.requestId, isNot(first.requestId));
      expect(second.selection, first.selection);
      expect(second.preset, first.preset);
      expect(second.before, first.before);
      expect(find.byKey(const ValueKey('studio-ai-diff')), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('a refused request says the server’s sentence, no retry', (
      tester,
    ) async {
      final repo = _repo()
        ..quickAssistError = const ApiException(
          code: 'SELECTION_REQUIRED',
          message: 'Select some text to rewrite.',
          statusCode: 400,
        );
      await openStudioAi(tester, repo);
      await runRewrite(tester);
      expect(find.text('Select some text to rewrite.'), findsOneWidget);
      expect(find.byKey(const ValueKey('studio-ai-try-again')), findsNothing);
      await closeStudio(tester);
    });

    testWidgets('an allowance already spent sends nothing', (tester) async {
      final gate = FakeStudioBillingGate(messagesAvailable: false);
      final repo = _repo();
      await openStudioAi(tester, repo, gate: gate);
      await runRewrite(tester);
      expect(repo.quickAssistRequests, isEmpty);
      expect(find.text('You’re out of messages for now.'), findsOneWidget);
      await closeStudio(tester);
    });
  });

  testWidgets('a selection past the limit asks for a shorter one', (
    tester,
  ) async {
    final long = List.filled(700, 'word word').join(' ');
    final repo = _repo(markdown: long);
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 0, end: long.length);
    await _openTools(tester);
    expect(find.byKey(const ValueKey('studio-ai-too-long')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-ai-tool-proofread')));
    await settle(tester);
    expect(repo.quickAssistRequests, isEmpty);
    await closeStudio(tester);
  });

  testWidgets('Discard leaves the text alone and saves no checkpoint', (
    tester,
  ) async {
    final repo = _repo();
    final gate = Completer<void>();
    repo.quickAssistGate = gate;
    await openStudioAi(tester, repo);
    await selectInBody(tester, start: 25, end: 43);
    await _openTools(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-tool-describe')));
    await settle(tester, const Duration(milliseconds: 500));
    // Waiting: honest words and a bar, never a bare spinner.
    expect(find.byKey(const ValueKey('studio-ai-waiting')), findsOneWidget);
    expect(find.text('Reading your passage…'), findsOneWidget);
    final request = repo.quickAssistRequests.single;
    expect(request.kind, QuickAssistKind.describe);
    expect(request.selection, 'The lamp was cold.');
    expect(request.preset, isNull);
    gate.complete();
    await settle(tester, const Duration(seconds: 1));
    await tester.tap(find.byKey(const ValueKey('studio-ai-discard')));
    await settle(tester);
    expect(bodyText(tester), _text);
    expect(repo.saves.where((save) => save.checkpoint != null), isEmpty);
    await closeStudio(tester);
  });
}
