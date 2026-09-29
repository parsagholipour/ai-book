import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/presentation/studio_image_block.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_ai_test_harness.dart';
import 'studio_test_harness.dart';

const _text =
    'Mara climbed the stairs. The lamp was cold.\n\n'
    'Below, the harbour slept.';

FakeStudioRepository _repo({String notes = ''}) => FakeStudioRepository(
  chapters: [
    FakeStudioChapter(
      id: 'c1',
      title: 'The Lamp',
      markdown: _text,
      notes: notes,
      updatedAt: DateTime.utc(2026, 9, 20),
    ),
    FakeStudioChapter(
      id: 'c2',
      title: 'The Harbour',
      markdown: 'Boats came home slowly. Mara was twelve.',
      updatedAt: DateTime.utc(2026, 9, 1),
    ),
  ],
);

ManuscriptAssist _assist(
  String id,
  LongAssistKind kind, {
  ManuscriptAssistStatus status = ManuscriptAssistStatus.ready,
  AssistResult? result,
  String? chapterId = 'c1',
}) => ManuscriptAssist(
  id: id,
  kind: kind,
  status: status,
  chapterId: chapterId,
  creditsCharged: 45,
  createdAt: DateTime.utc(2026, 9, 29, 10),
  result: result,
);

Future<void> _openAiTools(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('studio-more')));
  await settle(tester);
  await tester.tap(find.text('AI tools'));
  await settle(tester);
}

Future<void> _poll(WidgetTester tester) =>
    settle(tester, const Duration(milliseconds: 3500));

void main() {
  testWidgets(
    'the AI inbox lists what is waiting; a picture goes in at the cursor',
    (tester) async {
      final repo = _repo();
      repo.assists.addAll([
        _assist(
          'a-pic',
          LongAssistKind.illustrate,
          result: const AssistImageResult(
            url: '/assets/images/p1/studio-image-a-pic.png',
            alt: 'The lamp',
          ),
        ),
        _assist(
          'a-draft',
          LongAssistKind.draftChapter,
          status: ManuscriptAssistStatus.queued,
        ),
      ]);
      await openStudioAi(tester, repo);
      expect(repo.calls, contains('listOpenAssists'));
      expect(find.byTooltip('AI inbox · 1 waiting'), findsOneWidget);

      // The cursor was last after the first sentence.
      await selectInBody(tester, start: 10);
      FocusManager.instance.primaryFocus?.unfocus();
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('studio-ai-inbox')));
      await settle(tester);
      expect(find.text('Illustration'), findsOneWidget);
      expect(find.text('Chapter draft'), findsOneWidget);
      expect(find.text('Waiting to start…'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('studio-inbox-use-a-pic')));
      await settle(tester);
      expect(find.byType(StudioImageBlock), findsOneWidget);
      expect(repo.calls, contains('markAssistApplied:a-pic'));
      await settle(tester, const Duration(milliseconds: 1500));
      expect(
        repo.saves.last.markdown,
        'Mara climbed the stairs. The lamp was cold.\n\n'
        '![The lamp](/assets/images/p1/studio-image-a-pic.png)\n\n'
        'Below, the harbour slept.',
      );
      expect(
        repo.saves.any(
          (save) => save.checkpoint == ManuscriptSaveCheckpoint.beforeAi,
        ),
        isTrue,
      );
      await closeStudio(tester);
    },
  );

  testWidgets('Discard takes a result out of the inbox', (tester) async {
    final repo = _repo();
    repo.assists.add(
      _assist(
        'a-notes',
        LongAssistKind.chapterFeedback,
        result: const AssistNotesResult(notes: []),
      ),
    );
    await openStudioAi(tester, repo);
    await tester.tap(find.byKey(const ValueKey('studio-ai-inbox')));
    await settle(tester);
    await tester.tap(
      find.byKey(const ValueKey('studio-inbox-discard-a-notes')),
    );
    await settle(tester);
    expect(repo.calls, contains('dismissAssist:a-notes'));
    expect(find.textContaining('Nothing waiting'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets(
    'Draft this chapter asks for notes first, prices the length, and the '
    'draft is inserted only when the author says so',
    (tester) async {
      final repo = _repo();
      await openStudioAi(tester, repo);
      await _openAiTools(tester);
      await tester.tap(find.byKey(const ValueKey('studio-book-tool-draft')));
      await settle(tester);
      expect(
        find.byKey(const ValueKey('studio-draft-needs-notes')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('studio-draft-write-notes')));
      await settle(tester);
      await tester.enterText(
        find.byKey(const ValueKey('studio-notes-field')),
        'Mara finds the letter.',
      );
      await tester.tap(find.text('Done'));
      await settle(tester);
      expect(repo.saves.last.notes, 'Mara finds the letter.');
      expect(find.byKey(const ValueKey('studio-draft-notes')), findsOneWidget);

      expect(find.text('Draft chapter · 400 credits'), findsOneWidget);
      await tester.tap(find.text('3,000 words'));
      await tester.pump();
      expect(find.text('Draft chapter · 720 credits'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('studio-paid-button')));
      await settle(tester);

      final request = repo.longAssistRequests.single;
      expect(request.kind, LongAssistKind.draftChapter);
      expect(request.chapterId, 'c1');
      expect(request.targetWords, 3000);
      expect(request.notes, 'Mara finds the letter.');
      expect(find.text('Reading your notes…'), findsOneWidget);

      repo.completeAssist(
        repo.assists.single.id,
        const AssistDraftResult(markdown: 'The letter was older than she was.'),
      );
      await _poll(tester);
      expect(
        find.byKey(const ValueKey('studio-draft-preview')),
        findsOneWidget,
      );
      expect(bodyText(tester, 0), _text);

      await tester.tap(find.byKey(const ValueKey('studio-draft-insert')));
      await settle(tester);
      expect(bodyText(tester), '$_text\n\nThe letter was older than she was.');
      expect(
        repo.calls,
        contains('markAssistApplied:${repo.assists.single.id}'),
      );
      expect(
        repo.saves.any(
          (save) =>
              save.checkpoint == ManuscriptSaveCheckpoint.beforeAi &&
              save.markdown == _text,
        ),
        isTrue,
      );
      await closeStudio(tester);
    },
  );

  testWidgets('chapter feedback shows notes that find their passage', (
    tester,
  ) async {
    final repo = _repo();
    await openStudioAi(tester, repo);
    await _openAiTools(tester);
    await tester.tap(find.byKey(const ValueKey('studio-book-tool-feedback')));
    await settle(tester);
    expect(find.text('Get feedback · 35 credits'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-paid-button')));
    await settle(tester);
    expect(repo.longAssistRequests.single.kind, LongAssistKind.chapterFeedback);
    expect(repo.longAssistRequests.single.chapterId, 'c1');

    final id = repo.assists.single.id;
    repo.completeAssist(
      id,
      const AssistNotesResult(
        notes: [
          AssistNote(
            quote: 'The lamp was cold.',
            note: 'Say why the cold lamp matters.',
            isIssue: true,
          ),
          AssistNote(note: 'The pacing is calm and sure.', isIssue: false),
        ],
      ),
    );
    await _poll(tester);
    expect(find.text('Chapter feedback · 1 of 2'), findsOneWidget);
    expect(find.text('Issue'), findsOneWidget);

    await tester.tap(find.text('Say why the cold lamp matters.'));
    await settle(tester);
    final field = tester.widget<EditableText>(bodyFields().first);
    expect(
      field.controller.selection,
      const TextSelection(baseOffset: 25, extentOffset: 43),
    );

    await tester.tap(find.byKey(const ValueKey('studio-notes-next')));
    await settle(tester);
    expect(find.text('Suggestion'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('studio-notes-close')));
    await settle(tester);
    expect(find.byKey(const ValueKey('studio-notes-panel')), findsNothing);
    expect(repo.calls, contains('markAssistApplied:$id'));
    await closeStudio(tester);
  });

  testWidgets(
    'a consistency note in another chapter opens it and selects the passage',
    (tester) async {
      final repo = _repo();
      await openStudioAi(tester, repo);
      await _openAiTools(tester);
      await tester.tap(
        find.byKey(const ValueKey('studio-book-tool-consistency')),
      );
      await settle(tester);
      expect(find.text('Check the book · 200 credits'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('studio-paid-button')));
      await settle(tester);
      expect(repo.longAssistRequests.single.chapterId, isNull);

      // Back to writing: the result is announced when it lands.
      await tester.tap(find.byKey(const ValueKey('studio-wait-keep-writing')));
      await settle(tester);
      repo.completeAssist(
        repo.assists.single.id,
        const AssistNotesResult(
          notes: [
            AssistNote(
              quote: 'Mara was twelve.',
              note: 'Chapter 1 says she is ten.',
              isIssue: true,
              chapterId: 'c2',
            ),
          ],
        ),
      );
      await _poll(tester);
      expect(find.text('Consistency check is ready.'), findsOneWidget);
      await tester.tap(find.text('Show notes'));
      await settle(tester);
      expect(find.text('Chapter 2 · The Harbour'), findsOneWidget);

      await tester.tap(find.text('Chapter 1 says she is ten.'));
      await settle(tester, const Duration(seconds: 1));
      expect(find.text('The Harbour'), findsWidgets);
      final field = tester.widget<EditableText>(bodyFields().first);
      expect(field.controller.text, 'Boats came home slowly. Mara was twelve.');
      expect(
        field.controller.selection,
        const TextSelection(baseOffset: 24, extentOffset: 40),
      );
      await closeStudio(tester);
    },
  );

  testWidgets(
    'a blank book offers to plan its chapters, and the outline becomes '
    'chapters with notes',
    (tester) async {
      final repo = FakeStudioRepository(
        chapters: [
          FakeStudioChapter(id: 'c1', title: 'Chapter 1', markdown: ''),
        ],
      );
      await openStudioAi(tester, repo);
      await tester.tap(find.byKey(const ValueKey('studio-plan-with-ai')));
      await settle(tester);
      await tester.enterText(
        find.byKey(const ValueKey('studio-outline-premise')),
        'A lighthouse keeper’s daughter finds old letters.',
      );
      await tester.pump();
      expect(find.text('Plan my chapters · 40 credits'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('studio-paid-button')));
      await settle(tester);
      final request = repo.longAssistRequests.single;
      expect(request.kind, LongAssistKind.outline);
      expect(
        request.notes,
        'A lighthouse keeper’s daughter finds old letters.',
      );

      repo.completeAssist(
        repo.assists.single.id,
        const AssistOutlineResult(
          chapters: [
            AssistOutlineChapter(title: 'The Lamp', notes: 'Mara climbs up.'),
            AssistOutlineChapter(
              title: 'The Letters',
              notes: 'She finds them.',
            ),
            AssistOutlineChapter(title: 'The Sailor', notes: 'Who wrote them.'),
          ],
        ),
      );
      await _poll(tester);
      expect(find.text('Your outline'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('studio-outline-use')));
      await settle(tester, const Duration(seconds: 1));

      expect(
        [for (final chapter in repo.chapters) chapter.title],
        ['The Lamp', 'The Letters', 'The Sailor'],
      );
      expect(
        [for (final chapter in repo.chapters) chapter.notes],
        ['Mara climbs up.', 'She finds them.', 'Who wrote them.'],
      );
      expect(repo.calls.where((call) => call == 'addChapter'), hasLength(2));
      expect(
        repo.calls,
        contains('markAssistApplied:${repo.assists.single.id}'),
      );
      // A book with chapters is no longer blank: the offer is gone.
      expect(find.byKey(const ValueKey('studio-plan-with-ai')), findsNothing);
      await closeStudio(tester);
    },
  );
}
