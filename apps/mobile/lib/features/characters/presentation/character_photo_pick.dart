import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../../shared/media/photo_picker.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import 'character_crop_screen.dart';

/// What the reader picked out of the photo menu. Deliberately not an
/// `ImageSource`: the menu is presentation and knows nothing about the picker.
enum CharacterPhotoAction { gallery, camera }

/// The photo menu, opened by the add-a-picture affordance.
///
/// Removing lives on the picture itself now — every retained version has its
/// own delete — so this is only ever "where should the new one come from".
Future<CharacterPhotoAction?> showCharacterPhotoActions(BuildContext context) {
  return showAppActionSheet<CharacterPhotoAction>(
    context,
    builder: (sheetContext) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            key: const ValueKey('character-photo-gallery'),
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Photo library'),
            onTap: () =>
                Navigator.of(sheetContext).pop(CharacterPhotoAction.gallery),
          ),
          ListTile(
            key: const ValueKey('character-photo-camera'),
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take a photo'),
            onTap: () =>
                Navigator.of(sheetContext).pop(CharacterPhotoAction.camera),
          ),
        ],
      );
    },
  );
}

/// Picks an image and hands back the frame the reader approved, or null if they
/// backed out of either step.
///
/// The size cap stays on the picker: a raw 8000x6000 photo decodes to ~192 MB
/// of RGBA in the Dart heap and takes mid-range Android with it. It is raised
/// from the old 2048/85 because the crop throws pixels away and the *server* is
/// what finally resizes.
Future<Uint8List?> pickAndCropCharacterPhoto(
  BuildContext context, {
  required CharacterPhotoAction action,
  required PhotoPicker photoPicker,
}) async {
  final source = action == CharacterPhotoAction.camera
      ? ImageSource.camera
      : ImageSource.gallery;
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  // Loops so that a picture `package:image` cannot decode — HEIC is the real
  // case — sends the reader straight back to the picker rather than back to the
  // profile to start again.
  while (true) {
    XFile? picked;
    try {
      picked = await photoPicker.pickImage(
        source: source,
        purpose: PhotoPickerPurpose.characterCropSource,
      );
    } catch (_) {
      messenger.showAppSnackBar(
        SnackBar(
          content: Text(
            source == ImageSource.camera
                ? 'Could not open the camera.'
                : 'Could not open your photos.',
          ),
        ),
      );
      return null;
    }
    if (picked == null) return null;

    final bytes = await picked.readAsBytes();
    final outcome = await navigator.push<Object>(
      MaterialPageRoute<Object>(
        fullscreenDialog: true,
        builder: (_) => CharacterCropScreen(source: bytes),
      ),
    );
    if (outcome is Uint8List) return outcome;
    if (outcome != CharacterCropOutcome.chooseAnother) return null;
  }
}
