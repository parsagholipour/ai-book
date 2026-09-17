import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/appearance_prefs.dart';

abstract interface class AppearanceStore {
  Future<AppearanceMode> load();
  Future<void> save(AppearanceMode mode);
}

/// [AppearanceMode] as a JSON file in the app documents directory.
///
/// Same shape as the creation and reader stores: a handful of flags read once
/// per launch, so a file is enough and keeps the app free of another storage
/// dependency.
class FileAppearanceStore implements AppearanceStore {
  FileAppearanceStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_account';
  static const filename = 'appearance.json';

  /// Never throws. A preference the app failed to read is the system default —
  /// it must not be able to block the first frame.
  @override
  Future<AppearanceMode> load() async {
    try {
      final file = await _file();
      if (!await file.exists()) {
        return AppearanceMode.system;
      }
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) {
        return AppearanceMode.system;
      }
      return AppearanceMode.fromJson(json);
    } catch (_) {
      return AppearanceMode.system;
    }
  }

  /// Also never throws: failing to remember the last choice only costs the
  /// reader the system theme until they pick again.
  @override
  Future<void> save(AppearanceMode mode) async {
    try {
      final file = await _file();
      await file.writeAsString(jsonEncode(mode.toJson()));
    } catch (_) {
      // Ignored deliberately — see the doc comment.
    }
  }

  Future<File> _file() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    final directory = Directory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return File('${directory.path}/$filename');
  }
}

class MemoryAppearanceStore implements AppearanceStore {
  MemoryAppearanceStore([this._mode = AppearanceMode.system]);

  AppearanceMode _mode;

  @override
  Future<AppearanceMode> load() async => _mode;

  @override
  Future<void> save(AppearanceMode mode) async {
    _mode = mode;
  }
}

final appearanceStoreProvider = Provider<AppearanceStore>((ref) {
  return FileAppearanceStore();
});

final appearanceModeProvider =
    AsyncNotifierProvider<AppearanceModeController, AppearanceMode>(
      AppearanceModeController.new,
    );

class AppearanceModeController extends AsyncNotifier<AppearanceMode> {
  @override
  Future<AppearanceMode> build() {
    return ref.watch(appearanceStoreProvider).load();
  }

  Future<void> setMode(AppearanceMode mode) async {
    state = AsyncData(mode);
    await ref.read(appearanceStoreProvider).save(mode);
  }
}
