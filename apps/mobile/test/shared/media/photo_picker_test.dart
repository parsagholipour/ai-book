import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

void main() {
  test('character crop source uses the exact high-quality policy', () async {
    final adapter = _RecordingPhotoPickerAdapter(
      result: XFile.fromData(Uint8List.fromList([1]), path: 'character.jpg'),
    );
    final picker = PolicyPhotoPicker(adapter: adapter);

    final result = await picker.pickImage(
      source: ImageSource.gallery,
      purpose: PhotoPickerPurpose.characterCropSource,
    );

    expect(result?.name, 'character.jpg');
    expect(adapter.calls, [
      (
        source: ImageSource.gallery,
        maxWidth: 2400,
        maxHeight: 2400,
        imageQuality: 92,
      ),
    ]);
  });

  test('chat attachment uses the exact direct-upload policy', () async {
    final adapter = _RecordingPhotoPickerAdapter(
      result: XFile.fromData(Uint8List.fromList([2]), path: 'chat.jpg'),
    );
    final picker = PolicyPhotoPicker(adapter: adapter);

    final result = await picker.pickImage(
      source: ImageSource.camera,
      purpose: PhotoPickerPurpose.chatAttachment,
    );

    expect(result?.name, 'chat.jpg');
    expect(adapter.calls, [
      (
        source: ImageSource.camera,
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      ),
    ]);
  });

  test('gallery and camera sources are forwarded unchanged', () async {
    final adapter = _RecordingPhotoPickerAdapter();
    final picker = PolicyPhotoPicker(adapter: adapter);

    for (final source in ImageSource.values) {
      await picker.pickImage(
        source: source,
        purpose: PhotoPickerPurpose.chatAttachment,
      );
    }

    expect(adapter.calls.map((call) => call.source), ImageSource.values);
  });

  test('a cancelled plugin pick remains a cancellation', () async {
    final picker = PolicyPhotoPicker(adapter: _RecordingPhotoPickerAdapter());

    final result = await picker.pickImage(
      source: ImageSource.gallery,
      purpose: PhotoPickerPurpose.characterCropSource,
    );

    expect(result, isNull);
  });

  test('picker exceptions are passed back to the owning feature', () async {
    final error = StateError('picker unavailable');
    final picker = PolicyPhotoPicker(
      adapter: _RecordingPhotoPickerAdapter(error: error),
    );

    expect(
      picker.pickImage(
        source: ImageSource.camera,
        purpose: PhotoPickerPurpose.chatAttachment,
      ),
      throwsA(same(error)),
    );
  });
}

typedef _PickerCall = ({
  ImageSource source,
  double maxWidth,
  double maxHeight,
  int imageQuality,
});

final class _RecordingPhotoPickerAdapter implements PhotoPickerAdapter {
  _RecordingPhotoPickerAdapter({this.result, this.error});

  final XFile? result;
  final Object? error;
  final calls = <_PickerCall>[];

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required double maxWidth,
    required double maxHeight,
    required int imageQuality,
  }) async {
    calls.add((
      source: source,
      maxWidth: maxWidth,
      maxHeight: maxHeight,
      imageQuality: imageQuality,
    ));
    if (error case final error?) throw error;
    return result;
  }
}
