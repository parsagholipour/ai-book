import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/presentation/manuscript_editing_controller.dart';
import 'package:tomeza/features/studio/presentation/studio_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

import '../../support/fake_studio_characters.dart';
import '../../support/fake_studio_repository.dart';

final studioTestConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

/// Hands back one picked photo (or nothing) and records what was asked.
class FakeStudioPhotoPicker implements PhotoPicker {
  FakeStudioPhotoPicker({this.result});

  XFile? result;
  final List<({ImageSource source, PhotoPickerPurpose purpose})> calls = [];

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) async {
    calls.add((source: source, purpose: purpose));
    return result;
  }
}

XFile fakePhoto() => XFile.fromData(
  Uint8List.fromList(List.filled(64, 7)),
  name: 'harbour.jpg',
  path: 'harbour.jpg',
  mimeType: 'image/jpeg',
);

/// The Studio on its own, over a home page it can be popped back to.
Widget studioTestApp({
  required FakeStudioRepository repo,
  MemoryStudioLocalDrafts? drafts,
  PhotoPicker? picker,
  FakeStudioCharacters? characters,
  String? chapterId,
  bool openPublish = false,
  Brightness brightness = Brightness.light,
  ThemeData Function(ThemeData theme)? themeOverride,
  bool pushedFromHome = false,
}) {
  final studio = StudioScreen(
    projectId: repo.projectId,
    chapterId: chapterId,
    openPublish: openPublish,
  );
  ThemeData theme(ThemeData base) => themeOverride?.call(base) ?? base;
  return ProviderScope(
    overrides: [
      studioRepositoryProvider.overrideWithValue(repo),
      studioLocalDraftsProvider.overrideWithValue(
        drafts ?? MemoryStudioLocalDrafts(),
      ),
      photoPickerProvider.overrideWithValue(
        picker ?? FakeStudioPhotoPicker(result: fakePhoto()),
      ),
      // The outline's cast reads the character library.
      charactersRepositoryProvider.overrideWithValue(
        characters ?? FakeStudioCharacters(),
      ),
      appConfigProvider.overrideWithValue(studioTestConfig),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
    ],
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: theme(buildTomezaLightTheme()),
      darkTheme: theme(buildTomezaDarkTheme()),
      themeMode: brightness == Brightness.dark
          ? ThemeMode.dark
          : ThemeMode.light,
      home: pushedFromHome
          ? Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: TextButton(
                    onPressed: () => Navigator.of(
                      context,
                    ).push(MaterialPageRoute<void>(builder: (_) => studio)),
                    child: const Text('Open the Studio'),
                  ),
                ),
              ),
            )
          : studio,
    ),
  );
}

/// Pumps frames for [duration] in 100 ms steps: enough for sheets, snack bars
/// and saves, without `pumpAndSettle` (a focused field's cursor never settles).
Future<void> settle(
  WidgetTester tester, [
  Duration duration = const Duration(milliseconds: 600),
]) async {
  final steps = duration.inMilliseconds ~/ 100;
  for (var i = 0; i < steps; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// The chapter's body text fields, first to last.
Finder bodyFields() => find.byWidgetPredicate(
  (widget) =>
      widget is EditableText &&
      widget.controller is ManuscriptEditingController,
);

/// Takes the Studio down, so its timers stop with the test.
Future<void> closeStudio(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}
