import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/features/characters/presentation/character_crop_screen.dart';
import 'package:tomeza/features/characters/presentation/character_photo_pick.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

void main() {
  testWidgets('approved crop bytes are returned from the character flow', (
    tester,
  ) async {
    final picker = _QueuePhotoPicker([
      XFile.fromData(Uint8List.fromList([1, 2, 3]), path: 'portrait.jpg'),
    ]);
    late Future<Uint8List?> result;
    await tester.pumpWidget(
      _CharacterPickHarness(
        onPick: (context) {
          result = pickAndCropCharacterPhoto(
            context,
            action: CharacterPhotoAction.gallery,
            photoPicker: picker,
          );
        },
      ),
    );

    await tester.tap(find.text('Pick'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(CharacterCropScreen), findsOneWidget);

    final approved = Uint8List.fromList([9, 8, 7]);
    Navigator.of(
      tester.element(find.byType(CharacterCropScreen)),
    ).pop(approved);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(await result, approved);
    expect(picker.calls.length, 1);
  });

  testWidgets('choose another returns to the picker inside the same flow', (
    tester,
  ) async {
    final picker = _QueuePhotoPicker([
      XFile.fromData(Uint8List.fromList([1]), path: 'first.jpg'),
      null,
    ]);
    late Future<Uint8List?> result;
    await tester.pumpWidget(
      _CharacterPickHarness(
        onPick: (context) {
          result = pickAndCropCharacterPhoto(
            context,
            action: CharacterPhotoAction.camera,
            photoPicker: picker,
          );
        },
      ),
    );

    await tester.tap(find.text('Pick'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    Navigator.of(
      tester.element(find.byType(CharacterCropScreen)),
    ).pop(CharacterCropOutcome.chooseAnother);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(await result, isNull);
    expect(picker.calls, [
      (
        source: ImageSource.camera,
        purpose: PhotoPickerPurpose.characterCropSource,
      ),
      (
        source: ImageSource.camera,
        purpose: PhotoPickerPurpose.characterCropSource,
      ),
    ]);
  });

  for (final testCase in <({CharacterPhotoAction action, String message})>[
    (
      action: CharacterPhotoAction.gallery,
      message: 'Could not open your photos.',
    ),
    (
      action: CharacterPhotoAction.camera,
      message: 'Could not open the camera.',
    ),
  ]) {
    testWidgets('${testCase.action.name} picker errors keep specific copy', (
      tester,
    ) async {
      final picker = _ThrowingPhotoPicker();
      await tester.pumpWidget(
        _CharacterPickHarness(
          onPick: (context) {
            pickAndCropCharacterPhoto(
              context,
              action: testCase.action,
              photoPicker: picker,
            );
          },
        ),
      );

      await tester.tap(find.text('Pick'));
      await tester.pumpAndSettle();

      expect(find.text(testCase.message), findsOneWidget);
      expect(find.byType(CharacterCropScreen), findsNothing);
    });
  }
}

class _CharacterPickHarness extends StatelessWidget {
  const _CharacterPickHarness({required this.onPick});

  final void Function(BuildContext context) onPick;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => onPick(context),
            child: const Text('Pick'),
          ),
        ),
      ),
    );
  }
}

typedef _PhotoPickerCall = ({ImageSource source, PhotoPickerPurpose purpose});

final class _QueuePhotoPicker implements PhotoPicker {
  _QueuePhotoPicker(this._results);

  final List<XFile?> _results;
  final calls = <_PhotoPickerCall>[];

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) async {
    calls.add((source: source, purpose: purpose));
    return _results.removeAt(0);
  }
}

final class _ThrowingPhotoPicker implements PhotoPicker {
  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) {
    throw StateError('picker unavailable');
  }
}
