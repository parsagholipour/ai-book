import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/studio_ai_picture_card.dart';
import 'package:tomeza/features/studio/presentation/studio_image_block.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_ai_test_harness.dart';
import 'studio_test_harness.dart';

const _text =
    'Mara climbed the stairs. The lamp was cold.\n\n'
    'Below, the harbour slept.';

FakeStudioRepository _flow() => FakeStudioRepository(
  chapters: [FakeStudioChapter(id: 'c1', title: 'The Lamp', markdown: _text)],
);

FakeStudioRepository _pictureBook(String markdown) => FakeStudioRepository(
  layout: ManuscriptLayout.picture,
  kind: ManuscriptKind.picture,
  chapters: [
    FakeStudioChapter(id: 'c1', title: 'Your story', markdown: markdown),
  ],
);

/// Selects "The lamp was cold." and opens Illustrate from the ✨ tools.
Future<void> _illustrateSelection(WidgetTester tester) async {
  await selectInBody(tester, start: 25, end: 43);
  await tester.tap(find.byKey(const ValueKey('studio-toolbar-ai')));
  await settle(tester);
  await tester.tap(find.byKey(const ValueKey('studio-ai-tool-illustrate')));
  await settle(tester);
}

Future<void> _createPicture(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('studio-paid-button')));
  await settle(tester);
}

/// Long enough for the three-second poll to come round.
Future<void> _poll(WidgetTester tester) =>
    settle(tester, const Duration(milliseconds: 3500));

void main() {
  testWidgets(
    'a picture of the selection is priced, drawn after its paragraph, and '
    'becomes a picture in the chapter when it lands',
    (tester) async {
      final repo = _flow();
      await openStudioAi(tester, repo);
      await _illustrateSelection(tester);

      // The price comes from the billing table, on the confirming button.
      expect(find.text('Create picture · 50 credits'), findsOneWidget);
      expect(
        find.textContaining('Your book’s default style', findRichText: true),
        findsOneWidget,
      );
      final prompt = tester.widget<TextField>(
        find.byKey(const ValueKey('studio-illustrate-prompt')),
      );
      expect(prompt.controller!.text, 'The lamp was cold.');
      await tester.enterText(
        find.byKey(const ValueKey('studio-illustrate-prompt')),
        'A cold brass lamp at the top of a lighthouse stair',
      );
      await tester.pump();
      await _createPicture(tester);

      final request = repo.longAssistRequests.single;
      expect(request.kind, LongAssistKind.illustrate);
      expect(request.chapterId, 'c1');
      expect(
        request.prompt,
        'A cold brass lamp at the top of a lighthouse stair',
      );
      expect(request.passage, 'The lamp was cold.');

      // A placeholder after the paragraph; the chapter saves as it was.
      expect(find.byType(StudioAiPictureCard), findsOneWidget);
      expect(
        bodyText(tester, 0),
        'Mara climbed the stairs. The lamp was cold.',
      );
      expect(bodyText(tester, 1), 'Below, the harbour slept.');
      await settle(tester, const Duration(milliseconds: 1500));
      expect(repo.saves.every((save) => save.markdown == _text), isTrue);

      final id = repo.assists.single.id;
      repo.completeAssist(
        id,
        const AssistImageResult(
          url: '/assets/images/p1/studio-image-a1.png',
          alt: 'A cold lamp',
        ),
      );
      await _poll(tester);
      expect(find.byType(StudioAiPictureCard), findsNothing);
      expect(find.byType(StudioImageBlock), findsOneWidget);
      expect(repo.calls, contains('markAssistApplied:$id'));
      await settle(tester, const Duration(milliseconds: 1500));
      expect(
        repo.saves.last.markdown,
        'Mara climbed the stairs. The lamp was cold.\n\n'
        '![A cold lamp](/assets/images/p1/studio-image-a1.png)\n\n'
        'Below, the harbour slept.',
      );
      await closeStudio(tester);
    },
  );

  testWidgets('a picture that fails says why, and can be tried or removed', (
    tester,
  ) async {
    final repo = _flow();
    await openStudioAi(tester, repo);
    await _illustrateSelection(tester);
    await _createPicture(tester);
    final first = repo.assists.single.id;
    repo.failAssist(
      first,
      'This picture couldn’t be drawn. Your credits were returned.',
    );
    await _poll(tester);

    expect(
      find.text('This picture couldn’t be drawn. Your credits were returned.'),
      findsOneWidget,
    );
    expect(find.text('Try again · 50 credits'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-ai-picture-retry')));
    await settle(tester);
    expect(repo.longAssistRequests, hasLength(2));
    expect(repo.longAssistRequests.last.prompt, 'The lamp was cold.');
    expect(
      repo.longAssistRequests.last.requestId,
      isNot(repo.longAssistRequests.first.requestId),
    );
    expect(find.text('Starting your picture…'), findsOneWidget);

    repo.failAssist(repo.assists.last.id, 'Still no picture.');
    await _poll(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-picture-remove')));
    await settle(tester);
    expect(find.byType(StudioAiPictureCard), findsNothing);
    // The split closes up exactly as it was.
    expect(bodyText(tester), _text);
    await closeStudio(tester);
  });

  testWidgets('out of credits, the paywall opens and the sheet waits for a '
      'second tap', (tester) async {
    final gate = FakeStudioBillingGate(recovers: true);
    final repo = _flow()
      ..startAssistError = const ApiException(
        code: 'INSUFFICIENT_CREDITS',
        message: 'You need more credits for this action.',
        statusCode: 402,
      );
    await openStudioAi(tester, repo, gate: gate);
    await _illustrateSelection(tester);
    await _createPicture(tester);
    expect(gate.calls, contains('creditsNeeded'));
    expect(find.byType(StudioAiPictureCard), findsNothing);
    expect(
      find.text('You’re all set. Tap Create picture to go on.'),
      findsOneWidget,
    );

    await _createPicture(tester);
    expect(find.byType(StudioAiPictureCard), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('a spent illustrated-book slot opens the plans', (tester) async {
    final gate = FakeStudioBillingGate();
    final repo = _flow()
      ..startAssistError = const ApiException(
        code: 'IMAGE_LIMIT_REACHED',
        message: 'You’ve used this month’s illustrated books.',
        statusCode: 403,
      );
    await openStudioAi(tester, repo, gate: gate);
    await _illustrateSelection(tester);
    await _createPicture(tester);
    expect(gate.calls, contains('planRequired:IMAGE_LIMIT_REACHED'));
    expect(find.byType(StudioAiPictureCard), findsNothing);
    await closeStudio(tester);
  });

  testWidgets('a picture book page takes an AI picture into its slot', (
    tester,
  ) async {
    final repo = _pictureBook('A cat sat.\n\n<!-- page -->\n\nThe cat ran.');
    await openStudioAi(tester, repo);
    await tester.tap(find.text('Add a picture').first);
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('studio-picture-source-ai')));
    await settle(tester);
    final prompt = tester.widget<TextField>(
      find.byKey(const ValueKey('studio-illustrate-prompt')),
    );
    expect(prompt.controller!.text, 'A cat sat.');
    await _createPicture(tester);

    expect(repo.longAssistRequests.single.passage, 'A cat sat.');
    expect(find.byType(StudioAiPictureCard), findsOneWidget);
    // The second page's slot is still empty.
    expect(find.text('Add a picture'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets(
    'Illustrate every page prices the pages with words and no picture, then '
    'starts one picture per page',
    (tester) async {
      final repo = _pictureBook(
        'A cat sat.\n\n<!-- page -->\n\nThe cat ran.\n\n<!-- page -->\n\n'
        '![Moon](/assets/images/p1/upload-1.jpg)\n\nThe moon rose.'
        '\n\n<!-- page -->\n\n',
      );
      await openStudioAi(tester, repo);
      await tester.tap(find.byKey(const ValueKey('studio-more')));
      await settle(tester);
      await tester.tap(find.text('Illustrate every page'));
      await settle(tester);

      expect(find.text('Illustrate 2 pages · 100 credits'), findsOneWidget);
      expect(
        find.text('1 page has no words yet, so it’s left out.'),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const ValueKey('studio-illustrate-all-confirm')),
      );
      await settle(tester);

      expect(repo.longAssistRequests, hasLength(2));
      expect(
        [for (final request in repo.longAssistRequests) request.prompt],
        ['A cat sat.', 'The cat ran.'],
      );
      expect(
        repo.longAssistRequests.map((request) => request.requestId).toSet(),
        hasLength(2),
      );
      expect(find.byType(StudioAiPictureCard), findsNWidgets(2));
      await closeStudio(tester);
    },
  );

  testWidgets('Illustrate every page stops at a refusal and says so', (
    tester,
  ) async {
    final gate = FakeStudioBillingGate();
    final repo = _pictureBook(
      'A cat sat.\n\n<!-- page -->\n\nThe cat ran.\n\n<!-- page -->\n\nThe end.',
    );
    // The first page starts; the second is refused for credits.
    repo
      ..refuseStartAt = 1
      ..refuseStartWith = const ApiException(
        code: 'INSUFFICIENT_CREDITS',
        message: 'You need more credits for this action.',
        statusCode: 402,
      );
    await openStudioAi(tester, repo, gate: gate);
    await tester.tap(find.byKey(const ValueKey('studio-more')));
    await settle(tester);
    await tester.tap(find.text('Illustrate every page'));
    await settle(tester);
    await tester.tap(
      find.byKey(const ValueKey('studio-illustrate-all-confirm')),
    );
    await settle(tester);
    expect(gate.calls, contains('creditsNeeded'));
    expect(find.byType(StudioAiPictureCard), findsOneWidget);
    expect(repo.assists, hasLength(1));
    await closeStudio(tester);
  });
}
