import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

/// Why a photo is being picked.
///
/// The purpose owns the plugin policy so feature callers cannot accidentally
/// make a character crop source as lossy as a directly uploaded chat image, or
/// make every chat attachment pay the character crop's larger byte cost.
enum PhotoPickerPurpose { characterCropSource, chatAttachment }

/// The platform-facing seam around `image_picker`.
///
/// Tests inject a recording adapter here to prove the exact plugin options
/// selected by each [PhotoPickerPurpose].
abstract interface class PhotoPickerAdapter {
  Future<XFile?> pickImage({
    required ImageSource source,
    required double maxWidth,
    required double maxHeight,
    required int imageQuality,
  });
}

final class ImagePickerAdapter implements PhotoPickerAdapter {
  const ImagePickerAdapter();

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required double maxWidth,
    required double maxHeight,
    required int imageQuality,
  }) {
    return ImagePicker().pickImage(
      source: source,
      maxWidth: maxWidth,
      maxHeight: maxHeight,
      imageQuality: imageQuality,
    );
  }
}

/// Purpose-based photo picking used by features.
abstract interface class PhotoPicker {
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  });
}

final class PolicyPhotoPicker implements PhotoPicker {
  const PolicyPhotoPicker({this.adapter = const ImagePickerAdapter()});

  final PhotoPickerAdapter adapter;

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    required PhotoPickerPurpose purpose,
  }) {
    final policy = _policyFor(purpose);
    return adapter.pickImage(
      source: source,
      maxWidth: policy.maxWidth,
      maxHeight: policy.maxHeight,
      imageQuality: policy.imageQuality,
    );
  }
}

final photoPickerProvider = Provider<PhotoPicker>(
  (ref) => const PolicyPhotoPicker(),
);

typedef _PhotoPickerPolicy = ({
  double maxWidth,
  double maxHeight,
  int imageQuality,
});

// Character photos are source material for a later crop and server resize, so
// they deliberately retain more pixels and quality than direct chat uploads.
const _characterCropSourcePolicy = (
  maxWidth: 2400.0,
  maxHeight: 2400.0,
  imageQuality: 92,
);

// Chat photos are uploaded directly as attachments. Keep this distinct from
// the character source policy rather than normalizing both use cases.
const _chatAttachmentPolicy = (
  maxWidth: 2048.0,
  maxHeight: 2048.0,
  imageQuality: 85,
);

_PhotoPickerPolicy _policyFor(PhotoPickerPurpose purpose) {
  return switch (purpose) {
    PhotoPickerPurpose.characterCropSource => _characterCropSourcePolicy,
    PhotoPickerPurpose.chatAttachment => _chatAttachmentPolicy,
  };
}
