import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';

void main() {
  late Directory root;
  late FileStudioLocalDrafts drafts;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('studio-drafts-');
    drafts = FileStudioLocalDrafts(root: () async => root);
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  StudioLocalDraft draft({int base = 3, String markdown = 'Hello'}) =>
      StudioLocalDraft(
        projectId: 'p1',
        chapterId: 'c1',
        baseRevision: base,
        title: 'Chapter 1',
        markdown: markdown,
        notes: 'remember the lamp',
        status: ManuscriptChapterStatus.revised,
        savedAt: DateTime.utc(2026, 9, 29, 12),
      );

  test('writes, reads back and deletes a buffer', () async {
    expect(await drafts.read('p1', 'c1'), isNull);
    await drafts.write(draft(markdown: 'روزی روزگاری\n\n![x](/a.jpg)'));

    final file = File('${root.path}/studio/p1/c1.json');
    expect(await file.exists(), isTrue);

    final read = await drafts.read('p1', 'c1');
    expect(read!.baseRevision, 3);
    expect(read.title, 'Chapter 1');
    expect(read.markdown, 'روزی روزگاری\n\n![x](/a.jpg)');
    expect(read.notes, 'remember the lamp');
    expect(read.status, ManuscriptChapterStatus.revised);
    expect(read.savedAt, DateTime.utc(2026, 9, 29, 12));

    await drafts.delete('p1', 'c1');
    expect(await drafts.read('p1', 'c1'), isNull);
    // Deleting what is not there is not an error.
    await drafts.delete('p1', 'c1');
  });

  test('a later write replaces the earlier one whole', () async {
    await drafts.write(draft(base: 3, markdown: 'first'));
    await drafts.write(draft(base: 4, markdown: 'second'));
    final read = await drafts.read('p1', 'c1');
    expect(read!.baseRevision, 4);
    expect(read.markdown, 'second');
    expect(await File('${root.path}/studio/p1/c1.json.tmp').exists(), isFalse);
  });

  test('a torn or foreign file reads as no buffer', () async {
    final file = File('${root.path}/studio/p1/c1.json');
    await file.parent.create(recursive: true);
    await file.writeAsString('{"projectId": "p1", "chap');
    expect(await drafts.read('p1', 'c1'), isNull);

    await file.writeAsString(
      '{"projectId":"other","chapterId":"c1","baseRevision":1,"markdown":"x"}',
    );
    expect(await drafts.read('p1', 'c1'), isNull);
  });

  test('ids cannot climb out of the studio folder', () async {
    await drafts.write(
      StudioLocalDraft(
        projectId: '../p1',
        chapterId: '../../c1',
        baseRevision: 1,
        title: '',
        markdown: 'x',
        notes: '',
        savedAt: DateTime.utc(2026),
      ),
    );
    final written = await root
        .list(recursive: true)
        .where((entity) => entity is File)
        .map((entity) => entity.path)
        .toList();
    expect(written, hasLength(1));
    expect(written.single, startsWith('${root.path}/studio/'));
  });
}
