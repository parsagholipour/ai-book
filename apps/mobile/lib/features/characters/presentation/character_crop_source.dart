import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// Preparing the bytes a character cropper works on.
///
/// Everything here runs through `compute`, so every function is top-level and
/// takes one argument: decoding a 12-megapixel photo is a few hundred
/// milliseconds, and on the UI isolate that is a visible freeze between the
/// picker closing and the cropper appearing.

/// The longest edge the cropper is handed.
///
/// Above the server's own 1600 (`optimizeImageForStorage`), so a crop that
/// keeps most of the frame still arrives with resize headroom, and far below
/// what a phone camera produces — a raw 8000x6000 image decodes to ~192 MB of
/// RGBA in the Dart heap and takes mid-range Android with it.
const int characterCropSourceMaxEdge = 1800;

const int _jpegQuality = 92;

/// Decode, bake EXIF orientation, fit, and re-encode as JPEG.
///
/// Null when the bytes are not something `package:image` can read. HEIC/HEIF
/// and AVIF are the real cases: `image_picker` re-encodes when it is given a
/// size cap, but some Android OEM pickers still hand back the original file.
///
/// Baking the orientation here is what stops the picture being rotated twice —
/// the server's `optimizeImageForStorage` calls `sharp(...).rotate()`, and a
/// cropped frame whose EXIF tag survived would be turned a second time.
Uint8List? prepareCharacterCropSource(Uint8List raw) {
  final decoded = img.decodeImage(raw);
  if (decoded == null) return null;
  return img.encodeJpg(_fitted(img.bakeOrientation(decoded)), quality: _jpegQuality);
}

/// What a rotate button asks for: [CharacterCropRotation.source] is always the
/// *prepared original*, never the previous rotation, so four taps back to where
/// you started do not stack four generations of JPEG loss.
typedef CharacterCropRotation = ({Uint8List source, int quarterTurns});

/// Rotates the prepared source clockwise by [CharacterCropRotation.quarterTurns]
/// quarter turns. Null only if the prepared bytes somehow will not decode, which
/// [prepareCharacterCropSource] has already ruled out.
Uint8List? rotateCharacterCropSource(CharacterCropRotation input) {
  final quarterTurns = input.quarterTurns % 4;
  if (quarterTurns == 0) return input.source;
  final decoded = img.decodeJpg(input.source);
  if (decoded == null) return null;
  final rotated = img.copyRotate(decoded, angle: quarterTurns * 90);
  return img.encodeJpg(rotated, quality: _jpegQuality);
}

img.Image _fitted(img.Image source) {
  final wide = source.width >= source.height;
  final longestEdge = wide ? source.width : source.height;
  if (longestEdge <= characterCropSourceMaxEdge) return source;
  return img.copyResize(
    source,
    width: wide ? characterCropSourceMaxEdge : null,
    height: wide ? null : characterCropSourceMaxEdge,
    interpolation: img.Interpolation.average,
  );
}
