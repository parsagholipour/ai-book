import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/presentation/character_crop_screen.dart';
import 'package:tomeza/features/characters/presentation/character_editor_sheet.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

import 'character_test_support.dart';

/// Creating a character: the photo comes first and travels only once the
/// character exists, and a half-filled detail is marked where it is missing.
void main() {
  Future<FakeCharactersRepository> pumpCreate(
    WidgetTester tester, {
    PhotoPicker? picker,
  }) async {
    final repository = FakeCharactersRepository(testCharacter());
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          charactersRepositoryProvider.overrideWithValue(repository),
          if (picker != null) photoPickerProvider.overrideWithValue(picker),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showCharacterEditorSheet(context),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return repository;
  }

  testWidgets(
    'a new character is asked for a photo first, an existing one is not',
    (tester) async {
      await pumpCreate(tester);
      expect(
        find.byKey(const ValueKey('character-editor-photo')),
        findsOneWidget,
      );
      expect(find.text('Photo · optional'), findsOneWidget);
      // Nothing is chosen, so nothing is unsaved.
      await tester.tap(find.byTooltip('Close editor'));
      await tester.pumpAndSettle();
      expect(find.text('Discard changes?'), findsNothing);
    },
  );

  testWidgets('the approved frame is uploaded after the character is made', (
    tester,
  ) async {
    final picker = _OnePhotoPicker();
    final repository = await pumpCreate(tester, picker: picker);

    await tester.tap(
      find.byKey(const ValueKey('character-editor-choose-photo')),
    );
    await tester.pumpAndSettle();
    // Said before any photo is chosen, on every way in.
    expect(
      find.byKey(const ValueKey('character-photo-consent')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('character-photo-gallery')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(CharacterCropScreen), findsOneWidget);
    Navigator.of(tester.element(find.byType(CharacterCropScreen))).pop(_pixel);
    await tester.pumpAndSettle();

    expect(find.text('Photo ready'), findsOneWidget);
    // A chosen photo is unsaved work: closing asks first.
    await tester.tap(find.byTooltip('Close editor'));
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Mina');
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.uploadedByteLengths, [_pixel.length]);
    expect(find.text('New character'), findsNothing);
  });

  testWidgets('a half-filled detail is marked on the half that is missing', (
    tester,
  ) async {
    final repository = await pumpCreate(tester);
    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Mina');
    await tester.ensureVisible(find.text('Personality'));
    await tester.tap(find.text('Personality'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(find.text('Add what your stories should remember.'), findsOneWidget);
    expect(repository.updates, isEmpty);
    // Typing in the row is the answer to the refusal.
    await tester.enterText(find.widgetWithText(TextField, 'Value'), 'Bold');
    await tester.pumpAndSettle();
    expect(find.text('Add what your stories should remember.'), findsNothing);
  });

  testWidgets('a create that fails says so where the reader can see it', (
    tester,
  ) async {
    // A snack bar from inside the sheet opens on the page's Scaffold, which
    // the sheet covers: the button spun, stopped, and nothing else happened.
    final repository = await pumpCreate(tester);
    repository.createFailure = const ApiException(
      code: 'NETWORK_ERROR',
      message: 'Could not reach Tomeza. Check your connection.',
    );
    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Mina');
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(find.text('New character'), findsOneWidget);
    expect(
      find.text('Could not reach Tomeza. Check your connection.').hitTestable(),
      findsOneWidget,
    );

    // The next try clears it, and a create that works closes the sheet.
    repository.createFailure = null;
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();
    expect(find.text('New character'), findsNothing);
  });

  testWidgets('the length counter waits until the cap is in sight', (
    tester,
  ) async {
    await pumpCreate(tester);
    const field = ValueKey('character-description-field');
    await tester.enterText(find.byKey(field), 'x' * 500);
    await tester.pumpAndSettle();
    expect(find.text('500/2000'), findsNothing);
    await tester.enterText(find.byKey(field), 'x' * 1850);
    await tester.pumpAndSettle();
    expect(find.text('1850/2000'), findsOneWidget);
  });
}

/// A one-pixel PNG, so the sheet can actually draw the frame it is handed.
final Uint8List _pixel = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
);

final class _OnePhotoPicker implements PhotoPicker {
  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) async => XFile.fromData(Uint8List.fromList([1, 2, 3]), path: 'p.jpg');
}
