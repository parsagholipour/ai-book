import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/projects/presentation/ai_content_report.dart';
import 'package:tomeza/features/projects/presentation/book_preview_section.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/manuscript_blocks.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_image_block.dart';
import 'package:tomeza/shared/api/api_client.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_ai_test_harness.dart';
import 'studio_test_harness.dart';

/// Every Writing Studio suggestion is AI output, and Google Play's generative
/// AI policy wants each one reportable where it is shown: the quick tools'
/// sheet, the AI inbox, and an AI picture placed in a chapter.

class _RecordingApi implements ApiClient {
  final List<({String path, Object? data})> posts = [];

  @override
  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async {
    posts.add((path: path, data: data));
    return {
      'report': {'id': 'report-1', 'status': 'pending'},
    };
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

const _text =
    'Mara climbed the stairs. The lamp was cold.\n\n'
    'Below, the harbour slept.';

FakeStudioRepository _repo() => FakeStudioRepository(
  chapters: [FakeStudioChapter(id: 'c1', title: 'The Lamp', markdown: _text)],
);

/// The Studio with the report client recording what it would have sent.
Future<_RecordingApi> _openStudio(
  WidgetTester tester,
  FakeStudioRepository repo,
) async {
  final api = _RecordingApi();
  // Wide enough for the report dialog's reasons in the test font, still one
  // pane.
  tester.view.physicalSize = const Size(720, 900) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        aiContentReportsApiProvider.overrideWithValue(AiContentReportsApi(api)),
      ],
      child: studioAiTestApp(repo: repo),
    ),
  );
  await settle(tester);
  return api;
}

Future<void> _sendReport(WidgetTester tester) async {
  expect(find.byType(ContentReportDialog), findsOneWidget);
  await tester.tap(find.text('Send report'));
  await settle(tester);
}

void main() {
  testWidgets('a quick suggestion can be reported with what the sheet showed', (
    tester,
  ) async {
    final repo = _repo()
      ..nextQuickAssistResult = const QuickAssistResult(
        kind: QuickAssistKind.rewrite,
        suggestions: ['The lamp had gone cold hours ago.'],
        corrections: [],
        ideas: [],
      );
    final api = await _openStudio(tester, repo);
    await selectInBody(tester, start: 25, end: 43);
    await tester.tap(find.byKey(const ValueKey('studio-toolbar-ai')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('studio-ai-preset-vivid')));
    await settle(tester, const Duration(seconds: 1));

    final report = find.byKey(const ValueKey('studio-ai-report'));
    await tester.ensureVisible(report);
    await tester.tap(report);
    await settle(tester);
    await _sendReport(tester);

    final post = api.posts.single;
    expect(post.path, '/api/mobile/projects/p1/manuscript/assist/reports');
    expect(post.data, {
      'reason': 'other',
      'assistKind': 'rewrite',
      'suggestion': 'The lamp had gone cold hours ago.',
      'chapterId': 'c1',
      'selection': 'The lamp was cold.',
    });
    expect(find.text('Report sent for review.'), findsOneWidget);
    // Reporting leaves the suggestion where it was: still the author's to use.
    expect(find.byKey(const ValueKey('studio-ai-replace')), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('proofreading fixes are reported one line per fix', (
    tester,
  ) async {
    final repo = _repo()
      ..nextQuickAssistResult = const QuickAssistResult(
        kind: QuickAssistKind.proofread,
        suggestions: [],
        corrections: [
          AssistCorrection(find: 'stairs', replace: 'stair', reason: 'one'),
        ],
        ideas: [],
      );
    final api = await _openStudio(tester, repo);
    await selectInBody(tester, start: 0, end: 24);
    await tester.tap(find.byKey(const ValueKey('studio-toolbar-ai')));
    await settle(tester);
    await tester.tap(find.text('Fix spelling & grammar'));
    await settle(tester, const Duration(seconds: 1));

    final report = find.byKey(const ValueKey('studio-ai-report'));
    await tester.ensureVisible(report);
    await tester.tap(report);
    await settle(tester);
    await _sendReport(tester);

    final data = api.posts.single.data! as Map<String, Object?>;
    expect(data['assistKind'], 'proofread');
    expect(data['suggestion'], 'stairs → stair (one)');
    await closeStudio(tester);
  });

  testWidgets(
    'a finished suggestion in the AI inbox can be reported, a working one not',
    (tester) async {
      final repo = _repo();
      repo.assists.addAll([
        ManuscriptAssist(
          id: 'a-draft',
          kind: LongAssistKind.draftChapter,
          status: ManuscriptAssistStatus.ready,
          chapterId: 'c1',
          creditsCharged: 45,
          createdAt: DateTime.utc(2026, 9, 29, 10),
          result: const AssistDraftResult(markdown: 'The lamp burned again.'),
        ),
        ManuscriptAssist(
          id: 'a-pic',
          kind: LongAssistKind.illustrate,
          status: ManuscriptAssistStatus.running,
          chapterId: 'c1',
          creditsCharged: 45,
          createdAt: DateTime.utc(2026, 9, 29, 11),
        ),
      ]);
      final api = await _openStudio(tester, repo);
      await tester.tap(find.byKey(const ValueKey('studio-ai-inbox')));
      await settle(tester);

      expect(
        find.byKey(const ValueKey('studio-inbox-report-a-pic')),
        findsNothing,
      );
      await tester.tap(
        find.byKey(const ValueKey('studio-inbox-report-a-draft')),
      );
      await settle(tester);
      await _sendReport(tester);

      expect(
        api.posts.single.path,
        '/api/mobile/projects/p1/manuscript/assists/a-draft/reports',
      );
      expect(api.posts.single.data, {'reason': 'other'});
      await closeStudio(tester);
    },
  );

  group('a picture in the chapter', () {
    test('is an AI picture only by the name the worker gives it', () {
      expect(
        studioAiPictureSource('/assets/images/p1/studio-image-as0123.webp'),
        (projectId: 'p1', assistId: 'as0123'),
      );
      expect(
        studioAiPictureSource(
          'https://api.example.com/assets/images/p%201/studio-image-as9.png?v=3',
        ),
        (projectId: 'p 1', assistId: 'as9'),
      );
      expect(studioAiPictureSource('/assets/images/p1/upload-abc.png'), isNull);
      expect(studioAiPictureSource('/assets/images/p1/cover.png'), isNull);
    });

    Future<_RecordingApi> pumpBlock(WidgetTester tester, String url) async {
      final api = _RecordingApi();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            aiContentReportsApiProvider.overrideWithValue(
              AiContentReportsApi(api),
            ),
            appConfigProvider.overrideWithValue(studioTestConfig),
            apiAuthHeadersProvider.overrideWith(
              (ref) async => const <String, String>{},
            ),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: StudioImageBlock(
                  entry: StudioImageEntry(ImageBlock(alt: 'Lamp', url: url)),
                  onAction: (_) {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Picture options'));
      await settle(tester);
      return api;
    }

    testWidgets('an AI picture offers Report and sends its assist', (
      tester,
    ) async {
      final api = await pumpBlock(
        tester,
        '/assets/images/p1/studio-image-as0123.webp',
      );
      await tester.tap(find.byKey(const ValueKey('studio-image-report')));
      await settle(tester);
      await _sendReport(tester);
      expect(
        api.posts.single.path,
        '/api/mobile/projects/p1/manuscript/assists/as0123/reports',
      );
    });

    testWidgets('the author\'s own upload offers no Report', (tester) async {
      await pumpBlock(tester, '/assets/images/p1/upload-abc.png');
      expect(find.text('Replace picture'), findsOneWidget);
      expect(find.byKey(const ValueKey('studio-image-report')), findsNothing);
    });
  });
}
