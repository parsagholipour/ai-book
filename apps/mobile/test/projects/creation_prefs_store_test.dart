import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/domain/creation_prefs.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('creation-prefs-test');
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('saved preferences come back on the next launch', () async {
    await FileCreationPrefsStore(root: root).save(
      const CreationPrefs(
        visualsPromptSuppressed: true,
        creditWarningSuppressed: true,
      ),
    );

    final loaded = await FileCreationPrefsStore(root: root).load();
    expect(loaded.visualsPromptSuppressed, isTrue);
    expect(loaded.creditWarningSuppressed, isTrue);
  });

  test('a first launch has no file and reads as defaults', () async {
    final loaded = await FileCreationPrefsStore(root: root).load();
    expect(loaded.visualsPromptSuppressed, isFalse);
    expect(loaded.creditWarningSuppressed, isFalse);
  });

  test(
    'existing preferences retain the image choice and enable the warning',
    () {
      final prefs = CreationPrefs.fromJson({'visualsPromptSuppressed': true});
      expect(prefs.visualsPromptSuppressed, isTrue);
      expect(prefs.creditWarningSuppressed, isFalse);
      expect(
        const CreationPrefs(
          creditWarningSuppressed: true,
        ).copyWith(visualsPromptSuppressed: true).creditWarningSuppressed,
        isTrue,
      );
    },
  );

  test('unreadable preferences fall back rather than throw', () async {
    // A preference the app cannot read must not be able to block a build, so
    // corruption reads as "never asked" and the dialog simply appears again.
    final directory = Directory(
      '${root.path}/${FileCreationPrefsStore.directoryName}',
    );
    await directory.create(recursive: true);
    await File('${directory.path}/prefs.json').writeAsString('not json {');

    final loaded = await FileCreationPrefsStore(root: root).load();
    expect(loaded.visualsPromptSuppressed, isFalse);
  });
}
