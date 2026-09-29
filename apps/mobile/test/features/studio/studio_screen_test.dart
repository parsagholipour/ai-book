import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

FakeStudioRepository _repo({bool published = false, bool changed = false}) =>
    FakeStudioRepository(
      title: 'The Lantern Keeper',
      published: published,
      chapters: [
        FakeStudioChapter(
          id: 'c1',
          title: 'The Lamp',
          markdown: 'Every evening Mara climbed the stairs.',
          revision: 3,
          unpublished: changed,
          updatedAt: DateTime.utc(2026, 9, 20),
        ),
        FakeStudioChapter(
          id: 'c2',
          title: 'The Harbour',
          markdown: 'Boats came home slowly.',
          revision: 5,
          updatedAt: DateTime.utc(2026, 9, 1),
        ),
      ],
    );

Future<void> _open(
  WidgetTester tester,
  FakeStudioRepository repo, {
  MemoryStudioLocalDrafts? drafts,
  String? chapterId,
  bool pushedFromHome = false,
}) async {
  await tester.pumpWidget(
    studioTestApp(
      repo: repo,
      drafts: drafts,
      chapterId: chapterId,
      pushedFromHome: pushedFromHome,
    ),
  );
  if (pushedFromHome) {
    await tester.tap(find.text('Open the Studio'));
  }
  await settle(tester);
}

void main() {
  testWidgets('opens the chapter written in last, with its counts', (
    tester,
  ) async {
    final repo = _repo();
    await _open(tester, repo);

    expect(find.text('CHAPTER 1'), findsOneWidget);
    expect(find.text('The Lamp'), findsWidgets);
    expect(find.text('Saved'), findsOneWidget);
    expect(find.text('6 words  ·  Chapter 1 of 2'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('typing saves after a pause, from the chapter’s revision', (
    tester,
  ) async {
    final repo = _repo();
    await _open(tester, repo);

    await tester.enterText(
      bodyFields().first,
      'Every evening Mara climbed the old stairs.',
    );
    await tester.pump();
    expect(find.text('Saving…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1000));
    expect(repo.saves, isEmpty);

    await tester.pump(const Duration(milliseconds: 300));
    expect(repo.saves, hasLength(1));
    expect(repo.saves.single.baseRevision, 3);
    expect(repo.saves.single.chapterId, 'c1');
    expect(
      repo.saves.single.markdown,
      'Every evening Mara climbed the old stairs.',
    );
    await settle(tester);
    expect(find.text('Saved'), findsOneWidget);
    // The status line comes back when the keyboard goes.
    FocusManager.instance.primaryFocus?.unfocus();
    await settle(tester);
    expect(
      find.text('7 words  ·  +1 this session  ·  Chapter 1 of 2'),
      findsOneWidget,
    );
    await closeStudio(tester);
  });

  testWidgets('leaving the text saves without waiting for the pause', (
    tester,
  ) async {
    final repo = _repo();
    await _open(tester, repo);
    await tester.enterText(bodyFields().first, 'A thought, then a pause.');
    await tester.pump();
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    await tester.pump();
    expect(repo.saves.single.markdown, 'A thought, then a pause.');
    await settle(tester);
    await closeStudio(tester);
  });

  testWidgets('a chapter title edit is saved with the chapter', (tester) async {
    final repo = _repo();
    await _open(tester, repo);
    await tester.enterText(
      find.byKey(const ValueKey('studio-title-field')),
      'The Old Lamp',
    );
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.single.title, 'The Old Lamp');
    expect(find.byKey(const ValueKey('studio-bar-title')), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('studio-bar-title'))).data,
      'The Old Lamp',
    );
    await closeStudio(tester);
  });

  testWidgets('offline, the indicator says the words are on this device', (
    tester,
  ) async {
    final repo = _repo()..failSaves = 1;
    final drafts = MemoryStudioLocalDrafts();
    await _open(tester, repo, drafts: drafts);
    await tester.enterText(bodyFields().first, 'Written in a tunnel.');
    await tester.pump(const Duration(milliseconds: 1300));
    await tester.pump();
    expect(find.text('Saved on this device'), findsOneWidget);
    expect(drafts.drafts['p1/c1']!.markdown, 'Written in a tunnel.');

    await tester.pump(const Duration(seconds: 2));
    await settle(tester);
    expect(find.text('Saved'), findsOneWidget);
    expect(drafts.drafts, isEmpty);
    await closeStudio(tester);
  });

  group('the three-way choice', () {
    Future<void> conflict(
      WidgetTester tester,
      FakeStudioRepository repo,
    ) async {
      await _open(tester, repo);
      repo.chapters.first
        ..markdown = 'The tablet’s words.'
        ..revision = 4;
      await tester.enterText(bodyFields().first, 'The phone’s words.');
      await tester.pump(const Duration(milliseconds: 1300));
      await settle(tester);
      expect(
        find.text('This chapter was changed on another device'),
        findsOneWidget,
      );
    }

    testWidgets('keep this device’s version', (tester) async {
      final repo = _repo();
      await conflict(tester, repo);
      await tester.tap(find.text('Keep this device’s version'));
      await settle(tester);
      expect(repo.saves.last.baseRevision, 4);
      expect(repo.chapters.first.markdown, 'The phone’s words.');
      expect(find.text('Saved'), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('use the other version', (tester) async {
      final repo = _repo();
      await conflict(tester, repo);
      await tester.tap(find.text('Use the other version'));
      await settle(tester);
      expect(find.text('The tablet’s words.'), findsOneWidget);
      expect(find.text('Saved'), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('keep both', (tester) async {
      final repo = _repo();
      await conflict(tester, repo);
      await tester.tap(find.text('Keep both'));
      await settle(tester);
      expect(repo.chapters[1].title, 'The Lamp (copy)');
      expect(repo.chapters[1].markdown, 'The phone’s words.');
      expect(find.text('The tablet’s words.'), findsOneWidget);
      expect(find.textContaining('“The Lamp (copy)”'), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('closed without a choice, the indicator reopens it', (
      tester,
    ) async {
      final repo = _repo();
      await conflict(tester, repo);
      await tester.tapAt(const Offset(20, 20));
      await settle(tester);
      expect(find.text('Needs your choice'), findsOneWidget);
      await tester.tap(find.text('Needs your choice'));
      await settle(tester);
      expect(
        find.text('This chapter was changed on another device'),
        findsOneWidget,
      );
      await tester.tap(find.text('Use the other version'));
      await settle(tester);
      await closeStudio(tester);
    });
  });

  testWidgets('a buffer from a crash is restored quietly and saved', (
    tester,
  ) async {
    final repo = _repo();
    final drafts = MemoryStudioLocalDrafts();
    await drafts.write(
      StudioLocalDraft(
        projectId: 'p1',
        chapterId: 'c1',
        baseRevision: 3,
        title: 'The Lamp',
        markdown: 'Words the battery almost took.',
        notes: '',
        savedAt: DateTime.utc(2026, 9, 29),
      ),
    );
    await _open(tester, repo, drafts: drafts);
    expect(find.text('Words the battery almost took.'), findsOneWidget);
    expect(repo.chapters.first.markdown, 'Words the battery almost took.');
    expect(
      find.text('This chapter was changed on another device'),
      findsNothing,
    );
    await closeStudio(tester);
  });

  group('the book chat changed this chapter', () {
    FakeStudioRepository conflicted() {
      final repo = _repo(published: true, changed: true);
      repo.chapters.first.conflict = ManuscriptChapterConflict(
        title: 'The Lamp',
        markdown: 'Every night Mara climbed the stairs.',
        detectedAt: DateTime.utc(2026, 9, 28),
      );
      return repo;
    }

    testWidgets('use the book’s version', (tester) async {
      final repo = conflicted();
      await _open(tester, repo);
      expect(
        find.text(
          'This chapter changed in the book chat while you were editing it.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Use the book’s version'));
      await settle(tester);
      expect(repo.saves.single.resolveConflict?.wire, 'book');
      expect(find.text('Every night Mara climbed the stairs.'), findsOneWidget);
      expect(find.textContaining('changed in the book chat'), findsNothing);
      await closeStudio(tester);
    });

    testWidgets('keep mine', (tester) async {
      final repo = conflicted();
      await _open(tester, repo);
      await tester.tap(find.text('Keep mine'));
      await settle(tester);
      expect(repo.saves.single.resolveConflict?.wire, 'mine');
      expect(
        find.text('Every evening Mara climbed the stairs.'),
        findsOneWidget,
      );
      expect(find.textContaining('changed in the book chat'), findsNothing);
      await closeStudio(tester);
    });

    testWidgets('compare shows the words that differ', (tester) async {
      final repo = conflicted();
      await _open(tester, repo);
      await tester.tap(find.text('Compare'));
      await settle(tester);
      expect(find.text('Compare versions'), findsOneWidget);
      final text = tester
          .widgetList<SelectableText>(find.byType(SelectableText))
          .map((widget) => widget.textSpan!.toPlainText())
          .join();
      expect(text, contains('evening'));
      expect(text, contains('night'));
      await tester.tap(find.text('Keep mine').last);
      await settle(tester);
      expect(repo.saves.single.resolveConflict?.wire, 'mine');
      await closeStudio(tester);
    });
  });

  group('the publish action', () {
    testWidgets('a book never published says Publish', (tester) async {
      await _open(tester, _repo());
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('studio-publish')),
          matching: find.text('Publish'),
        ),
        findsOneWidget,
      );
      await closeStudio(tester);
    });

    testWidgets('a published book with nothing new shows no action', (
      tester,
    ) async {
      await _open(tester, _repo(published: true));
      expect(find.byKey(const ValueKey('studio-publish')), findsNothing);

      await tester.enterText(bodyFields().first, 'A fresh line.');
      await tester.pump();
      expect(find.text('Update book'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1300));
      await closeStudio(tester);
    });

    testWidgets('a published book with changes says Update book', (
      tester,
    ) async {
      await _open(tester, _repo(published: true, changed: true));
      expect(find.text('Update book'), findsOneWidget);
      await closeStudio(tester);
    });

    testWidgets('a blocked publish explains itself instead of opening', (
      tester,
    ) async {
      final repo = _BlockedRepo();
      await _open(tester, repo);
      await tester.tap(find.byKey(const ValueKey('studio-publish')));
      await settle(tester);
      expect(
        find.text(ManuscriptPublishBlock.audiobook.message),
        findsOneWidget,
      );
      expect(repo.saves, isEmpty);
      await closeStudio(tester);
    });
  });

  testWidgets('focus mode hides the chrome and comes back', (tester) async {
    await _open(tester, _repo());
    await tester.tap(find.byKey(const ValueKey('studio-more')));
    await settle(tester);
    await tester.tap(find.text('Focus mode'));
    await settle(tester);
    expect(find.byKey(const ValueKey('studio-more')), findsNothing);
    expect(find.byKey(const ValueKey('studio-status-line')), findsNothing);
    expect(find.text('Exit focus'), findsOneWidget);

    await tester.tap(find.text('Exit focus'));
    await settle(tester);
    expect(find.byKey(const ValueKey('studio-more')), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-status-line')), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('the toolbar shows while writing and formats the selection', (
    tester,
  ) async {
    final repo = _repo();
    await _open(tester, repo);
    expect(find.byTooltip('Bold'), findsNothing);

    await tester.showKeyboard(bodyFields().first);
    final field = tester.widget<EditableText>(bodyFields().first);
    field.controller.selection = const TextSelection(
      baseOffset: 6,
      extentOffset: 13,
    );
    await tester.pump();
    expect(find.byTooltip('Bold'), findsOneWidget);
    expect(find.byKey(const ValueKey('studio-status-line')), findsNothing);

    await tester.tap(find.byTooltip('Bold'));
    await tester.pump();
    expect(field.controller.text, 'Every **evening** Mara climbed the stairs.');

    await tester.tap(find.byTooltip('Heading'));
    await tester.pump();
    expect(field.controller.text, startsWith('## Every'));

    await tester.pump(const Duration(milliseconds: 1300));
    expect(
      repo.saves.last.markdown,
      '## Every **evening** Mara climbed the stairs.',
    );
    await closeStudio(tester);
  });

  testWidgets('keyboard shortcuts: bold, italic and save now', (tester) async {
    final repo = _repo();
    await _open(tester, repo);
    await tester.showKeyboard(bodyFields().first);
    final field = tester.widget<EditableText>(bodyFields().first);
    field.controller.selection = const TextSelection(
      baseOffset: 0,
      extentOffset: 5,
    );
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyB);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    expect(field.controller.text, startsWith('**Every**'));

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyI);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    expect(field.controller.text, startsWith('***Every***'));

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    expect(repo.saves, hasLength(1), reason: 'saved without waiting');
    await settle(tester);
    await closeStudio(tester);
  });

  testWidgets('leaving saves first, then goes back', (tester) async {
    final repo = _repo();
    await _open(tester, repo, pushedFromHome: true);
    await tester.enterText(bodyFields().first, 'Last words before leaving.');
    await tester.pump();

    await tester.tap(find.byTooltip('Back'));
    await settle(tester);
    expect(repo.saves.single.markdown, 'Last words before leaving.');
    expect(find.text('Open the Studio'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('chapter notes and status are saved with the chapter', (
    tester,
  ) async {
    final repo = _repo();
    await _open(tester, repo);
    await tester.tap(find.byKey(const ValueKey('studio-more')));
    await settle(tester);
    await tester.tap(find.text('Chapter notes'));
    await settle(tester);
    await tester.enterText(
      find.byKey(const ValueKey('studio-notes-field')),
      'Mara is afraid of the dark.',
    );
    await tester.tap(find.text('Done'));
    await settle(tester);
    expect(repo.saves.last.notes, 'Mara is afraid of the dark.');

    await tester.tap(find.byKey(const ValueKey('studio-more')));
    await settle(tester);
    await tester.tap(find.text('Chapter status'));
    await settle(tester);
    await tester.tap(find.text('Revised'));
    await settle(tester);
    expect(repo.saves.last.status, ManuscriptChapterStatus.revised);
    await closeStudio(tester);
  });

  testWidgets('a load failure offers another try', (tester) async {
    final repo = _FailingOnceRepo();
    await _open(tester, repo);
    expect(find.text('Your book didn’t open'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await settle(tester);
    expect(find.text('Your book didn’t open'), findsNothing);
    expect(find.text('CHAPTER 1'), findsOneWidget);
    await closeStudio(tester);
  });
}

class _BlockedRepo extends FakeStudioRepository {
  @override
  Future<Manuscript> getManuscript(String projectId) async {
    final base = snapshot();
    return Manuscript(
      projectId: base.projectId,
      revision: base.revision,
      source: base.source,
      layout: base.layout,
      kind: base.kind,
      title: base.title,
      language: base.language,
      wordCount: base.wordCount,
      published: base.published,
      hasUnpublishedChanges: base.hasUnpublishedChanges,
      chapters: base.chapters,
      updatedAt: base.updatedAt,
      publishBlock: ManuscriptPublishBlock.audiobook,
    );
  }
}

class _FailingOnceRepo extends FakeStudioRepository {
  bool _failed = false;

  @override
  Future<Manuscript> getManuscript(String projectId) async {
    if (!_failed) {
      _failed = true;
      throw Exception('offline');
    }
    return super.getManuscript(projectId);
  }
}
