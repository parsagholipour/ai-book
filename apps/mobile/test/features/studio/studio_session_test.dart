import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/studio_session.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../support/fake_studio_repository.dart';

class _Delegate implements StudioSessionDelegate {
  StudioConflictChoice? choice;
  final List<StudioConflict> conflicts = [];
  final List<String> messages = [];

  @override
  Future<StudioConflictChoice?> chooseConflictResolution(
    StudioConflict conflict,
  ) async {
    conflicts.add(conflict);
    return choice;
  }

  @override
  void showStudioMessage(
    String message, {
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    messages.add(message);
  }
}

FakeStudioRepository _repo({bool published = false}) => FakeStudioRepository(
  published: published,
  chapters: [
    FakeStudioChapter(
      id: 'c1',
      title: 'The Lamp',
      markdown: 'Every evening Mara climbed the stairs.',
      revision: 3,
      updatedAt: DateTime.utc(2026, 9, 1),
    ),
    FakeStudioChapter(
      id: 'c2',
      title: 'The Harbour',
      markdown: 'Boats came home slowly.',
      revision: 5,
      updatedAt: DateTime.utc(2026, 9, 20),
    ),
  ],
);

({StudioSession session, _Delegate delegate, MemoryStudioLocalDrafts drafts})
_session(FakeStudioRepository repo, {MemoryStudioLocalDrafts? drafts}) {
  final delegate = _Delegate();
  final buffers = drafts ?? MemoryStudioLocalDrafts();
  final session = StudioSession(
    projectId: 'p1',
    repository: repo,
    drafts: buffers,
  )..delegate = delegate;
  addTearDown(session.dispose);
  return (session: session, delegate: delegate, drafts: buffers);
}

void _type(StudioSession session, String text) {
  session.document!.textEntries.first.setText(text);
}

void main() {
  testWidgets('opens the chapter written in last, unless one is asked for', (
    tester,
  ) async {
    final repo = _repo();
    final latest = _session(repo).session;
    await latest.start();
    expect(latest.chapterId, 'c2');
    expect(latest.chapterPosition, 2);

    final asked = _session(repo).session;
    await asked.start(chapterId: 'c1');
    expect(asked.chapterId, 'c1');
    expect(asked.document!.title.text, 'The Lamp');
    expect(asked.saveState, StudioSaveState.saved);

    // The reader links by the book chapter a chapter published as.
    repo.chapters.first.bookChapterId = 'book-chapter-7';
    final linked = _session(repo).session;
    await linked.start(chapterId: 'book-chapter-7');
    expect(linked.chapterId, 'c1');

    final gone = _session(repo).session;
    await gone.start(chapterId: 'deleted-long-ago');
    expect(gone.chapterId, 'c2');
  });

  testWidgets('saves 1.2 s after the last keystroke, from the right revision', (
    tester,
  ) async {
    final repo = _repo();
    final (:session, delegate: _, :drafts) = _session(repo);
    await session.start(chapterId: 'c1');

    _type(session, 'Every evening Mara climbed the old stairs.');
    expect(session.dirty, isTrue);
    expect(session.saveState, StudioSaveState.saving);
    await tester.pump(const Duration(milliseconds: 1000));
    _type(session, 'Every evening Mara climbed the old stone stairs.');
    await tester.pump(const Duration(milliseconds: 1100));
    expect(repo.saves, isEmpty, reason: 'the second keystroke reset the wait');

    await tester.pump(const Duration(milliseconds: 150));
    expect(repo.saves, hasLength(1));
    expect(repo.saves.single.baseRevision, 3);
    expect(
      repo.saves.single.markdown,
      'Every evening Mara climbed the old stone stairs.',
    );
    expect(session.saveState, StudioSaveState.saved);
    expect(session.baseRevision, 4);
    expect(drafts.drafts, isEmpty, reason: 'confirmed, so the buffer goes');

    _type(session, 'A new first line.');
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.last.baseRevision, 4);
  });

  testWidgets('offline: the buffer keeps the text and saves retry', (
    tester,
  ) async {
    final repo = _repo()..failSaves = 2;
    final (:session, delegate: _, :drafts) = _session(repo);
    await session.start(chapterId: 'c1');

    _type(session, 'Written on a train.');
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves, hasLength(1));
    expect(session.saveState, StudioSaveState.savedOnDevice);
    final buffer = drafts.drafts['p1/c1']!;
    expect(buffer.markdown, 'Written on a train.');
    expect(buffer.baseRevision, 3);

    await tester.pump(const Duration(seconds: 2));
    expect(repo.saves, hasLength(2), reason: 'first retry after 2 s');
    expect(session.saveState, StudioSaveState.savedOnDevice);

    await tester.pump(const Duration(seconds: 4));
    expect(repo.saves, hasLength(2), reason: 'second retry waits 5 s');
    await tester.pump(const Duration(seconds: 1));
    expect(repo.saves, hasLength(3));
    expect(session.saveState, StudioSaveState.saved);
    expect(drafts.drafts, isEmpty);
  });

  testWidgets(
    'a refused save that is not the network is reported, not retried',
    (tester) async {
      final repo = _repo()
        ..nextSaveError = const ApiException(
          code: 'VALIDATION_ERROR',
          message: 'That chapter is too long to save.',
          statusCode: 400,
        );
      final (:session, :delegate, drafts: _) = _session(repo);
      await session.start(chapterId: 'c1');
      _type(session, 'Something.');
      await tester.pump(const Duration(milliseconds: 1300));
      expect(delegate.messages, ['That chapter is too long to save.']);
      expect(session.saveState, StudioSaveState.savedOnDevice);
      await tester.pump(const Duration(seconds: 40));
      expect(repo.saves, hasLength(1));
    },
  );

  group('another device saved first', () {
    Future<
      ({StudioSession session, _Delegate delegate, FakeStudioRepository repo})
    >
    conflicted(WidgetTester tester, StudioConflictChoice choice) async {
      final repo = _repo();
      final (:session, :delegate, drafts: _) = _session(repo);
      delegate.choice = choice;
      await session.start(chapterId: 'c1');
      // The other device's save.
      repo.chapters.first
        ..markdown = 'The other device wrote this.'
        ..revision = 4;
      _type(session, 'This device wrote this.');
      await tester.pump(const Duration(milliseconds: 1300));
      await tester.pump();
      return (session: session, delegate: delegate, repo: repo);
    }

    testWidgets('keep this device’s version', (tester) async {
      final (:session, :delegate, :repo) = await conflicted(
        tester,
        StudioConflictChoice.keepMine,
      );
      expect(delegate.conflicts.single.server.revision, 4);
      expect(repo.saves.last.baseRevision, 4);
      expect(repo.saves.last.markdown, 'This device wrote this.');
      expect(repo.chapters.first.markdown, 'This device wrote this.');
      expect(session.saveState, StudioSaveState.saved);
    });

    testWidgets('use the other version', (tester) async {
      final (:session, delegate: _, :repo) = await conflicted(
        tester,
        StudioConflictChoice.useOther,
      );
      expect(session.document!.markdown, 'The other device wrote this.');
      expect(session.baseRevision, 4);
      expect(session.dirty, isFalse);
      expect(repo.saves, hasLength(1), reason: 'nothing more was sent');
    });

    testWidgets('keep both', (tester) async {
      final (:session, delegate: _, :repo) = await conflicted(
        tester,
        StudioConflictChoice.keepBoth,
      );
      expect(repo.calls, contains('addChapter'));
      final copy = repo.chapters[1];
      expect(copy.title, 'The Lamp (copy)');
      expect(copy.markdown, 'This device wrote this.');
      expect(session.chapterId, 'c1');
      expect(session.document!.markdown, 'The other device wrote this.');
      expect(session.manuscript!.chapters, hasLength(3));
    });

    testWidgets('dismissed, it stays open until chosen', (tester) async {
      final repo = _repo();
      final (:session, :delegate, drafts: _) = _session(repo);
      await session.start(chapterId: 'c1');
      repo.chapters.first
        ..markdown = 'Other.'
        ..revision = 4;
      _type(session, 'Mine.');
      await tester.pump(const Duration(milliseconds: 1300));
      await tester.pump();
      expect(session.saveState, StudioSaveState.conflict);
      final sent = repo.saves.length;

      _type(session, 'Mine, and more.');
      await tester.pump(const Duration(milliseconds: 1300));
      expect(repo.saves, hasLength(sent), reason: 'paused until chosen');

      // The indicator reopens the choice.
      delegate.choice = StudioConflictChoice.keepMine;
      await session.reopenConflict();
      expect(repo.saves.last.markdown, 'Mine, and more.');
      expect(repo.saves.last.baseRevision, 4);
      expect(session.saveState, StudioSaveState.saved);
    });
  });

  group('a buffer left from an earlier sitting', () {
    testWidgets('from the same revision is restored quietly and saved', (
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
          markdown: 'The words the crash almost took.',
          notes: '',
          savedAt: DateTime.utc(2026, 9, 29),
        ),
      );
      final (:session, :delegate, drafts: _) = _session(repo, drafts: drafts);
      await session.start(chapterId: 'c1');
      await tester.pump();
      expect(delegate.conflicts, isEmpty);
      expect(session.document!.markdown, 'The words the crash almost took.');
      expect(repo.saves.single.baseRevision, 3);
      expect(repo.chapters.first.markdown, 'The words the crash almost took.');
      expect(drafts.drafts, isEmpty);
    });

    testWidgets('from an older revision asks which to keep', (tester) async {
      final repo = _repo();
      final drafts = MemoryStudioLocalDrafts();
      await drafts.write(
        StudioLocalDraft(
          projectId: 'p1',
          chapterId: 'c1',
          baseRevision: 2,
          title: 'The Lamp',
          markdown: 'Offline words.',
          notes: '',
          savedAt: DateTime.utc(2026, 9, 29),
        ),
      );
      final (:session, :delegate, drafts: _) = _session(repo, drafts: drafts);
      delegate.choice = StudioConflictChoice.keepMine;
      await session.start(chapterId: 'c1');
      await tester.pump();
      expect(delegate.conflicts.single.fromBuffer, isTrue);
      expect(delegate.conflicts.single.deviceMarkdown, 'Offline words.');
      expect(repo.saves.single.baseRevision, 3);
      expect(repo.chapters.first.markdown, 'Offline words.');
    });

    testWidgets('that matches the server is simply cleared', (tester) async {
      final repo = _repo();
      final drafts = MemoryStudioLocalDrafts();
      await drafts.write(
        StudioLocalDraft(
          projectId: 'p1',
          chapterId: 'c1',
          baseRevision: 1,
          title: 'The Lamp',
          markdown: 'Every evening Mara climbed the stairs.',
          notes: '',
          savedAt: DateTime.utc(2026, 9, 29),
        ),
      );
      final (:session, :delegate, drafts: _) = _session(repo, drafts: drafts);
      await session.start(chapterId: 'c1');
      expect(delegate.conflicts, isEmpty);
      expect(drafts.drafts, isEmpty);
      expect(repo.saves, isEmpty);
    });
  });

  testWidgets('a chapter the book chat changed: keep mine or use the book’s', (
    tester,
  ) async {
    final repo = _repo();
    repo.chapters.first.conflict = ManuscriptChapterConflict(
      title: 'The Lamp',
      markdown: 'The chat’s version.',
      detectedAt: DateTime.utc(2026, 9, 28),
    );
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start(chapterId: 'c1');
    expect(session.bookConflict, isNotNull);

    await session.useBookVersion();
    expect(repo.saves.last.resolveConflict, ManuscriptConflictResolution.book);
    expect(session.bookConflict, isNull);
    expect(session.document!.markdown, 'The chat’s version.');
    expect(session.dirty, isFalse);

    repo.chapters.first.conflict = ManuscriptChapterConflict(
      title: 'The Lamp',
      markdown: 'Another chat edit.',
      detectedAt: DateTime.utc(2026, 9, 29),
    );
    await session.reloadChapter();
    await session.keepMineOverBook();
    expect(repo.saves.last.resolveConflict, ManuscriptConflictResolution.mine);
    expect(repo.chapters.first.markdown, 'The chat’s version.');
    expect(session.bookConflict, isNull);
  });

  testWidgets('a restored version is saved with a restore checkpoint', (
    tester,
  ) async {
    final repo = _repo();
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start(chapterId: 'c1');
    await session.applyVersion(
      ManuscriptVersion(
        id: 'v1',
        reason: ManuscriptVersionReason.auto,
        title: 'The Lamp, early',
        wordCount: 2,
        createdAt: DateTime.utc(2026, 9, 1),
        markdown: 'Early draft.',
      ),
    );
    expect(repo.saves.single.checkpoint, ManuscriptSaveCheckpoint.restore);
    expect(repo.chapters.first.markdown, 'Early draft.');
    expect(
      repo.chapters.first.versions.first.markdown,
      'Every evening Mara climbed the stairs.',
    );
  });

  testWidgets('switching chapters saves first and counts the session', (
    tester,
  ) async {
    final repo = _repo();
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start(chapterId: 'c1');
    _type(session, 'Every evening Mara climbed the stairs, two at a time.');
    expect(session.sessionWordDelta, 4);

    await session.switchChapter('c2');
    expect(repo.saves.single.chapterId, 'c1');
    expect(session.chapterId, 'c2');
    _type(session, 'Boats.');
    expect(session.sessionWordDelta, 4 - 3);
    await tester.pump(const Duration(milliseconds: 1300));
  });

  testWidgets('the publish action follows the book’s state', (tester) async {
    final fresh = _session(_repo()).session;
    await fresh.start();
    expect(fresh.publishLabel, 'Publish');

    final repo = _repo(published: true);
    final published = _session(repo).session;
    await published.start();
    expect(published.publishLabel, isNull, reason: 'nothing to update');

    _type(published, 'An edit.');
    expect(published.publishLabel, 'Update book');
    await tester.pump(const Duration(milliseconds: 1300));
    expect(published.publishLabel, 'Update book');
  });

  testWidgets('adds at the end unless told where, one add at a time', (
    tester,
  ) async {
    final repo = _repo();
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start(chapterId: 'c1');
    expect(session.addChapterLabel, 'Add chapter 3');

    // A second add while the first is on its way adds nothing.
    final first = session.addChapter();
    expect(session.addingChapter, isTrue);
    expect(await session.addChapter(), isFalse);
    expect(await first, isTrue);
    expect(session.addingChapter, isFalse);
    expect(repo.chapters.map((c) => c.title), [
      'The Lamp',
      'The Harbour',
      'Chapter 3',
    ]);
    expect(session.chapterPosition, 3);
    expect(session.addChapterLabel, 'Add chapter 4');

    expect(await session.addChapter(afterChapterId: 'c1'), isTrue);
    expect(repo.chapters.map((c) => c.title), [
      'The Lamp',
      'Chapter 2',
      'The Harbour',
      'Chapter 3',
    ]);
    expect(session.chapterPosition, 2);
    expect(repo.calls.where((call) => call == 'addChapter'), hasLength(2));
  });

  testWidgets('deleting a chapter can be undone; the last one stays', (
    tester,
  ) async {
    final repo = _repo();
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start(chapterId: 'c2');
    expect(await session.deleteChapter('c2'), isNull);
    expect(session.manuscript!.chapters.map((c) => c.id), ['c1']);
    expect(session.chapterId, 'c1', reason: 'the open chapter went away');

    expect(await session.deleteChapter('c1'), contains('at least one chapter'));

    await session.restoreChapter('c2');
    expect(session.manuscript!.chapters.map((c) => c.id), ['c1', 'c2']);
  });

  testWidgets('a reorder shows at once and sticks', (tester) async {
    final repo = _repo();
    final (:session, delegate: _, drafts: _) = _session(repo);
    await session.start();
    final pending = session.reorderChapters(['c2', 'c1']);
    expect(session.manuscript!.chapters.map((c) => c.id), ['c2', 'c1']);
    await pending;
    expect(repo.chapters.map((c) => c.id), ['c2', 'c1']);
    expect(session.chapterPosition, 1);
  });
}
