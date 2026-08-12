import 'package:crop_your_image/crop_your_image.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import 'character_crop_source.dart';

/// How the `Crop` widget is built, so `flutter test` can stand in for it.
///
/// The package is pure Dart and would run under the test binding, but its crop
/// path uses isolates, which is slow and flaky in a widget test. Same seam as
/// `readerViewerBuilderProvider` for the PDF reader.
typedef CharacterCropBuilder =
    Widget Function(BuildContext context, CharacterCropConfig config);

/// What the crop screen hands back.
///
/// "Choose another" is its own outcome rather than a plain pop: the picture
/// that could not be decoded was already chosen, so dropping the reader back on
/// the profile with no picker would ask them to start the gesture again with no
/// explanation of why they were sent there.
enum CharacterCropOutcome { chooseAnother }

/// What a stand-in needs to behave like the real cropper.
class CharacterCropConfig {
  const CharacterCropConfig({
    required this.image,
    required this.controller,
    required this.onCropped,
    required this.onStatusChanged,
  });

  final Uint8List image;
  final CropController controller;
  final void Function(CropResult result) onCropped;
  final void Function(CropStatus status) onStatusChanged;
}

/// Choose the frame, then approve it.
///
/// This sits between the picker and the upload because the frame the reader
/// happened to pick is what every illustrated book will draw this character's
/// face from — and until now it went straight to the server unseen.
///
/// Pops a [CharacterCropOutcome]: the approved bytes, a request for a
/// different picture, or nothing when the reader backed out.
class CharacterCropScreen extends StatefulWidget {
  const CharacterCropScreen({
    required this.source,
    this.cropBuilder,
    super.key,
  });

  /// The bytes the picker returned, before any decoding.
  final Uint8List source;

  @visibleForTesting
  final CharacterCropBuilder? cropBuilder;

  @override
  State<CharacterCropScreen> createState() => _CharacterCropScreenState();
}

class _CharacterCropScreenState extends State<CharacterCropScreen> {
  final _controller = CropController();

  /// The decoded, orientation-baked, downscaled JPEG every rotation is
  /// recomputed from. Null while it is being prepared, or when the bytes turned
  /// out to be something `package:image` cannot read.
  Uint8List? _prepared;
  Uint8List? _shown;

  bool _preparing = true;
  bool _undecodable = false;
  bool _rotating = false;
  bool _cropping = false;
  int _quarterTurns = 0;
  CropStatus _status = CropStatus.nothing;
  String? _error;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    final prepared = await compute(prepareCharacterCropSource, widget.source);
    if (!mounted) return;
    setState(() {
      _preparing = false;
      _undecodable = prepared == null;
      _prepared = prepared;
      _shown = prepared;
    });
  }

  Future<void> _rotate(int turns) async {
    final prepared = _prepared;
    if (prepared == null || _rotating || _cropping) return;
    final next = (_quarterTurns + turns) % 4;
    setState(() => _rotating = true);
    // Always from the prepared original, never from what is on screen: four
    // taps back to where you started must not stack four generations of loss.
    final rotated = await compute(rotateCharacterCropSource, (
      source: prepared,
      quarterTurns: next,
    ));
    if (!mounted) return;
    setState(() {
      _rotating = false;
      if (rotated != null) {
        _quarterTurns = next;
        _shown = rotated;
        _status = CropStatus.nothing;
      }
    });
  }

  void _reset() {
    if (_quarterTurns == 0 || _rotating || _cropping) return;
    AppHaptics.selection();
    setState(() {
      _quarterTurns = 0;
      _shown = _prepared;
      _status = CropStatus.nothing;
    });
  }

  void _approve() {
    if (_status != CropStatus.ready || _cropping) return;
    AppHaptics.commit();
    setState(() {
      _cropping = true;
      _error = null;
    });
    _controller.crop();
  }

  void _onCropped(CropResult result) {
    if (!mounted) return;
    switch (result) {
      case CropSuccess(:final croppedImage):
        Navigator.of(context).pop(croppedImage);
      case CropFailure():
        // Clearing the flag is what keeps the screen usable: leaving it set
        // would disable every control with nothing left to un-disable it.
        setState(() {
          _cropping = false;
          _error = 'That picture could not be cropped. Try a different one.';
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: const CloseButton(),
        title: const Text('Crop photo'),
      ),
      body: SafeArea(top: false, child: _body()),
    );
  }

  Widget _body() {
    if (_preparing) {
      // A real 300-600ms decode on a 12-megapixel photo, so it gets a state
      // rather than a frozen frame.
      return const AppLoadingState(message: 'Opening your photo');
    }
    if (_undecodable) {
      return AppErrorState(
        icon: Icons.image_not_supported_outlined,
        title: "That photo can't be opened",
        message:
            "This picture is in a format the app can't read — some phones "
            'save photos as HEIC. Try another one, or take a new photo.',
        actionLabel: 'Choose another',
        actionIcon: Icons.photo_library_outlined,
        onRetry: () =>
            Navigator.of(context).pop(CharacterCropOutcome.chooseAnother),
      );
    }
    return Column(
      children: [
        Expanded(child: _cropArea()),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md,
              AppSpacing.sm,
              AppSpacing.md,
              0,
            ),
            child: AppInlineNotice(
              icon: Icons.error_outline,
              tone: AppTone.error,
              title: "That didn't work",
              message: _error!,
            ),
          ),
        _controls(),
      ],
    );
  }

  Widget _cropArea() {
    final shown = _shown;
    if (shown == null) return const SizedBox.shrink();
    final config = CharacterCropConfig(
      image: shown,
      controller: _controller,
      onCropped: _onCropped,
      onStatusChanged: (status) {
        if (mounted && status != _status) setState(() => _status = status);
      },
    );
    final builder = widget.cropBuilder ?? _buildCrop;
    return Semantics(
      label: 'Crop area. Pinch to zoom, drag to move.',
      child: AbsorbPointer(
        absorbing: _cropping || _rotating,
        // A new key per rotation: the widget takes its image once, so reusing
        // it would keep showing the previous turn.
        child: KeyedSubtree(
          key: ValueKey('character-crop-$_quarterTurns'),
          child: builder(context, config),
        ),
      ),
    );
  }

  Widget _buildCrop(BuildContext context, CharacterCropConfig config) {
    final colors = Theme.of(context).colorScheme;
    return Crop(
      image: config.image,
      controller: config.controller,
      onCropped: config.onCropped,
      onStatusChanged: config.onStatusChanged,
      aspectRatio: 1,
      initialRectBuilder: InitialRectBuilder.withSizeAndRatio(
        size: 0.86,
        aspectRatio: 1,
      ),
      // Square rect with a circular guide drawn inside it, never `withCircleUi`:
      // this one file is shown round in every avatar and square in the profile
      // header, the strip and the book render, so drawing both is the only
      // framing that does not lie about one of them. `cropCircle()` would also
      // force a PNG, since JPEG has no alpha.
      withCircleUi: false,
      interactive: true,
      fixCropRect: false,
      // The package default is white, which is a flashbang in dark mode.
      baseColor: colors.surfaceContainerLowest,
      maskColor: colors.scrim.withValues(alpha: 0.62),
      radius: AppRadii.control,
      filterQuality: FilterQuality.medium,
      // Safe only because `prepareCharacterCropSource` produced these bytes.
      // Left null, the cropper's encoder map falls back to PNG, and a 1800px
      // photo as PNG is several megabytes over mobile data — to be re-encoded
      // to JPEG by the server the moment it lands.
      formatDetector: (_) => ImageFormat.jpeg,
      progressIndicator: const CircularProgressIndicator(strokeWidth: 2.5),
      cornerDotBuilder: (size, alignment) =>
          DotControl(color: colors.onSurface),
      overlayBuilder: (context, rect) => _CropGuides(colors: colors),
    );
  }

  Widget _controls() {
    final busy = _cropping || _rotating;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.sm,
        AppSpacing.md,
        AppSpacing.md,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                key: const ValueKey('character-crop-rotate-left'),
                tooltip: 'Rotate left',
                onPressed: busy ? null : () => _rotate(3),
                icon: const Icon(Icons.rotate_left),
              ),
              IconButton(
                key: const ValueKey('character-crop-rotate-right'),
                tooltip: 'Rotate right',
                onPressed: busy ? null : () => _rotate(1),
                icon: const Icon(Icons.rotate_right),
              ),
              const SizedBox(width: AppSpacing.xs),
              AppButton.text(
                label: 'Reset',
                onPressed: busy || _quarterTurns == 0 ? null : _reset,
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          AppButton.primary(
            key: const ValueKey('character-crop-approve'),
            label: 'Use photo',
            leading: const Icon(Icons.check),
            loading: _cropping,
            loadingLabel: 'Cropping',
            expanded: true,
            onPressed: _status == CropStatus.ready && !busy ? _approve : null,
          ),
        ],
      ),
    );
  }
}

/// A thirds grid plus the circle the avatar will clip to, so the reader can see
/// both framings of the one file they are choosing.
class _CropGuides extends StatelessWidget {
  const _CropGuides({required this.colors});

  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: CustomPaint(
        painter: _CropGuidePainter(color: colors.onSurface.withValues(alpha: 0.45)),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _CropGuidePainter extends CustomPainter {
  const _CropGuidePainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = color.withValues(alpha: 0.35)
      ..strokeWidth = 1;
    for (var i = 1; i < 3; i++) {
      final dx = size.width * i / 3;
      final dy = size.height * i / 3;
      canvas.drawLine(Offset(dx, 0), Offset(dx, size.height), line);
      canvas.drawLine(Offset(0, dy), Offset(size.width, dy), line);
    }
    final circle = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    canvas.drawCircle(
      size.center(Offset.zero),
      (size.shortestSide / 2) - 1,
      circle,
    );
  }

  @override
  bool shouldRepaint(_CropGuidePainter oldDelegate) => oldDelegate.color != color;
}
