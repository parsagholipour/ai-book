import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/data/reader_annotation_store.dart';
import 'package:tomeza/features/reader/data/reader_settings_store.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';

TextMarkupAnnotation markup(String id, {int page = 1}) {
  return TextMarkupAnnotation(
    id: id,
    page: page,
    revision: 1,
    colorIndex: 0,
    createdAt: DateTime.utc(2026, 7, 20),
    updatedAt: DateTime.utc(2026, 7, 20),
    style: ReaderMarkupStyle.highlight,
    rects: const [NormRect(0.1, 0.2, 0.3, 0.02)],
    quote: 'a passage from $id',
  );
}

void main() {
  late Directory root;
  late ReaderStorage storage;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('reader-annotations');
    storage = ReaderStorage(root: root);
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  group('annotations', () {
    test('round trips a book’s markup', () async {
      final store = ReaderAnnotationStore(storage: storage);

      await store.save('project-1', [markup('a', page: 2), markup('b')]);
      final loaded = await store.load('project-1');

      expect(loaded.map((entry) => entry.id), ['a', 'b']);
      expect(loaded.first.page, 2);
      expect(loaded.first.quote, 'a passage from a');
    });

    test('a book with no markup loads as empty, not as an error', () async {
      final store = ReaderAnnotationStore(storage: storage);
      expect(await store.load('never-opened'), isEmpty);
    });

    test('one book’s markup never reaches another', () async {
      final store = ReaderAnnotationStore(storage: storage);

      await store.save('project-1', [markup('a')]);
      await store.save('project-2', [markup('b'), markup('c')]);

      expect((await store.load('project-1')).map((e) => e.id), ['a']);
      expect((await store.load('project-2')).map((e) => e.id), ['b', 'c']);
    });

    test('a corrupt file loses the markup, not the book', () async {
      final store = ReaderAnnotationStore(storage: storage);
      await store.save('project-1', [markup('a')]);
      final directory = await storage.projectDirectory('project-1');
      await File('${directory.path}/annotations.json').writeAsString('{ nope');

      expect(await store.load('project-1'), isEmpty);
    });

    test('one unreadable entry does not cost the reader the others', () async {
      final store = ReaderAnnotationStore(storage: storage);
      final directory = await storage.projectDirectory('project-1');
      await File('${directory.path}/annotations.json').writeAsString('''
{"version":1,"annotations":[
  {"type":"markup","id":"good","page":3,"revision":1,"colorIndex":0,
   "style":"highlight","quote":"kept","rects":[[0.1,0.2,0.3,0.02]]},
  {"type":"markup","id":"bad"},
  "not even an object"
]}
''');

      final loaded = await store.load('project-1');

      expect(loaded, hasLength(1));
      expect(loaded.single.id, 'good');
    });

    test('tombstones come back, so a later sync can see the deletion', () async {
      final store = ReaderAnnotationStore(storage: storage);
      await store.save('project-1', [
        markup('a').deleted(DateTime.utc(2026, 7, 24)),
      ]);

      final loaded = await store.load('project-1');

      expect(loaded, hasLength(1));
      expect(loaded.single.isDeleted, isTrue);
    });

    test('a write leaves no partial file behind', () async {
      final store = ReaderAnnotationStore(storage: storage);
      await store.save('project-1', [markup('a')]);

      final directory = await storage.projectDirectory('project-1');
      final names = await directory
          .list()
          .map((entry) => entry.uri.pathSegments.last)
          .toList();

      expect(names, contains('annotations.json'));
      expect(
        names.where((name) => name.endsWith('.part')),
        isEmpty,
        reason: 'the temporary file must be renamed into place, not left',
      );
    });
  });

  group('settings', () {
    test('round trip', () async {
      final store = ReaderSettingsStore(storage: storage);

      await store.save(
        const ReaderSettings(
          tint: ReaderPageTint.night,
          dimLevel: 0.4,
          keepAwake: true,
          markupColorIndex: 3,
          inkColorIndex: 5,
          inkWidth: 0.008,
        ),
      );
      final loaded = await store.load();

      expect(loaded.tint, ReaderPageTint.night);
      expect(loaded.dimLevel, closeTo(0.4, 1e-9));
      expect(loaded.keepAwake, isTrue);
      expect(loaded.markupColorIndex, 3);
      expect(loaded.inkColorIndex, 5);
      expect(loaded.inkWidth, closeTo(0.008, 1e-9));
    });

    test('defaults when nothing has been chosen yet', () async {
      final loaded = await ReaderSettingsStore(storage: storage).load();
      expect(loaded.tint, ReaderPageTint.none);
      expect(loaded.dimLevel, 0);
      expect(loaded.keepAwake, isFalse);
    });

    test('out-of-range values are pulled back into range', () async {
      final directory = await storage.rootDirectory();
      await File('${directory.path}/settings.json').writeAsString(
        '{"tint":"invented","dimLevel":9,"inkWidth":50}',
      );

      final loaded = await ReaderSettingsStore(storage: storage).load();

      expect(loaded.tint, ReaderPageTint.none);
      expect(loaded.dimLevel, ReaderSettings.maxDimLevel);
      expect(loaded.inkWidth, ReaderSettings.maxInkWidth);
    });

    test('settings live outside any one book', () async {
      // Deleting a book clears its directory; the reader's own preferences must
      // not go with it.
      await ReaderSettingsStore(
        storage: storage,
      ).save(const ReaderSettings(tint: ReaderPageTint.sepia));
      await ReaderAnnotationStore(
        storage: storage,
      ).save('project-1', [markup('a')]);

      await storage.clearProject('project-1');

      expect(await ReaderAnnotationStore(storage: storage).load('project-1'), isEmpty);
      expect(
        (await ReaderSettingsStore(storage: storage).load()).tint,
        ReaderPageTint.sepia,
      );
    });
  });
}
