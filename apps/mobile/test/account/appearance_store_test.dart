import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/account/data/appearance_store.dart';
import 'package:tomeza/features/account/domain/appearance_prefs.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('appearance-prefs-test');
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  test('saved appearance comes back on the next launch', () async {
    await FileAppearanceStore(root: root).save(AppearanceMode.dark);

    final loaded = await FileAppearanceStore(root: root).load();
    expect(loaded, AppearanceMode.dark);
  });

  test('a first launch has no file and reads as system', () async {
    final loaded = await FileAppearanceStore(root: root).load();
    expect(loaded, AppearanceMode.system);
  });

  test('unreadable preferences fall back rather than throw', () async {
    final directory = Directory(
      '${root.path}/${FileAppearanceStore.directoryName}',
    );
    await directory.create(recursive: true);
    await File(
      '${directory.path}/${FileAppearanceStore.filename}',
    ).writeAsString('not json {');

    final loaded = await FileAppearanceStore(root: root).load();
    expect(loaded, AppearanceMode.system);
  });
}
