import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import 'character_network_image.dart';

/// Opens the picture the reader tapped, with the rest of the history either
/// side of it.
///
/// The route recipe is copied from the chat's image preview so the two feel
/// identical; the contents are not, because that one is a single image with no
/// pager, no counter and no per-picture actions.
Future<CharacterImageAction2?> showCharacterImageViewer({
  required BuildContext context,
  required List<CharacterImage> images,
  required int initialIndex,
  required String characterName,
}) {
  return Navigator.of(context).push<CharacterImageAction2>(
    PageRouteBuilder<CharacterImageAction2>(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.92),
      barrierDismissible: true,
      transitionDuration: AppMotion.medium,
      reverseTransitionDuration: AppMotion.fast,
      pageBuilder: (_, _, _) => CharacterImageViewer(
        images: images,
        initialIndex: initialIndex,
        characterName: characterName,
      ),
      transitionsBuilder: (context, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    ),
  );
}

/// What the viewer asks its caller to do next, keyed to a picture.
typedef CharacterImageAction2 = ({String imageId, CharacterViewerIntent intent});

enum CharacterViewerIntent { makeMain, showAsPhoto, options }

class CharacterImageViewer extends StatefulWidget {
  const CharacterImageViewer({
    required this.images,
    required this.initialIndex,
    required this.characterName,
    super.key,
  });

  final List<CharacterImage> images;
  final int initialIndex;
  final String characterName;

  @override
  State<CharacterImageViewer> createState() => _CharacterImageViewerState();
}

class _CharacterImageViewerState extends State<CharacterImageViewer> {
  late final PageController _pages = PageController(
    initialPage: widget.initialIndex,
  );
  late int _index = widget.initialIndex;

  /// One per page, so zooming one picture does not leave the next one scaled.
  final _transforms = <int, TransformationController>{};

  bool _chromeVisible = true;
  double _dragOffset = 0;

  @override
  void dispose() {
    _pages.dispose();
    for (final controller in _transforms.values) {
      controller.dispose();
    }
    super.dispose();
  }

  TransformationController _transformFor(int index) =>
      _transforms.putIfAbsent(index, TransformationController.new);

  bool get _zoomed =>
      _transformFor(_index).value.getMaxScaleOnAxis() > 1.01;

  CharacterImage get _current => widget.images[_index];

  void _handleDragUpdate(DragUpdateDetails details) {
    // Panning a zoomed picture must not dismiss the viewer.
    if (_zoomed) return;
    setState(() => _dragOffset += details.delta.dy);
  }

  void _handleDragEnd(DragEndDetails details) {
    if (_zoomed) return;
    final velocity = details.velocity.pixelsPerSecond.dy.abs();
    if (_dragOffset.abs() > 120 || velocity > 700) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _dragOffset = 0);
  }

  void _doubleTap(TapDownDetails details) {
    final controller = _transformFor(_index);
    setState(() {
      if (controller.value.getMaxScaleOnAxis() > 1.01) {
        controller.value = Matrix4.identity();
        return;
      }
      // Anchored on the tap, because pinching a square avatar is fiddly.
      final position = details.localPosition;
      controller.value = Matrix4.identity()
        ..translateByDouble(-position.dx * 1.5, -position.dy * 1.5, 0, 1)
        ..scaleByDouble(2.5, 2.5, 2.5, 1);
    });
  }

  @override
  Widget build(BuildContext context) {
    final fade = (1 - (_dragOffset.abs() / 400)).clamp(0.0, 1.0);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Opacity(
        opacity: fade,
        child: Transform.translate(
          offset: Offset(0, _dragOffset),
          child: Stack(
            children: [
              Positioned.fill(child: _pager()),
              if (_chromeVisible) ...[
                Positioned(top: 0, left: 0, right: 0, child: _topBar()),
                Positioned(bottom: 0, left: 0, right: 0, child: _bottomBar()),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _pager() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      // A tap toggles the chrome rather than dismissing. With a pager, a tap
      // during a mis-swipe would throw the reader out of a gallery they are
      // still browsing — the one deliberate divergence from the chat preview.
      onTap: () => setState(() => _chromeVisible = !_chromeVisible),
      onDoubleTapDown: _doubleTap,
      onDoubleTap: () {},
      onVerticalDragUpdate: _handleDragUpdate,
      onVerticalDragEnd: _handleDragEnd,
      child: PageView.builder(
        controller: _pages,
        itemCount: widget.images.length,
        onPageChanged: (index) => setState(() => _index = index),
        itemBuilder: (context, index) {
          return InteractiveViewer(
            transformationController: _transformFor(index),
            minScale: 1,
            maxScale: 5,
            child: Center(
              child: CharacterNetworkImage(
                url: widget.images[index].url,
                fit: BoxFit.contain,
                semanticLabel: widget.characterName,
                placeholder: const Center(
                  child: SizedBox.square(
                    dimension: 28,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  ),
                ),
                errorPlaceholder: const Center(
                  child: Text(
                    "Couldn't load this picture",
                    style: TextStyle(color: Colors.white70),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _topBar() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
        child: Row(
          children: [
            const CloseButton(color: Colors.white),
            Expanded(
              child: Semantics(
                liveRegion: true,
                label: 'Picture ${_index + 1} of ${widget.images.length}',
                child: ExcludeSemantics(
                  child: Text(
                    '${_index + 1} of ${widget.images.length}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
            IconButton(
              key: const ValueKey('character-viewer-options'),
              tooltip: 'Picture options',
              color: Colors.white,
              onPressed: () => Navigator.of(context).pop((
                imageId: _current.id,
                intent: CharacterViewerIntent.options,
              )),
              icon: const Icon(Icons.more_horiz),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bottomBar() {
    final image = _current;
    final caption = image.source == CharacterImageSource.generated
        ? 'AI illustration'
        : image.isOwnArtwork
        ? 'Your artwork'
        : 'Your photo';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          0,
          AppSpacing.md,
          AppSpacing.md,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              image.isMain ? 'Main picture · $caption' : caption,
              textAlign: TextAlign.center,
              // Dark chrome in both themes: this sits on black, and inheriting
              // the scheme's foreground would be unreadable dark green in the
              // light theme.
              style: const TextStyle(color: Colors.white70),
            ),
            if (image.canBeMain || image.canBeShownAsPhoto) ...[
              const SizedBox(height: AppSpacing.xs),
              FilledButton.icon(
                key: const ValueKey('character-viewer-make-main'),
                onPressed: () => Navigator.of(context).pop((
                  imageId: image.id,
                  intent: image.canBeMain
                      ? CharacterViewerIntent.makeMain
                      : CharacterViewerIntent.showAsPhoto,
                )),
                icon: const Icon(Icons.check_circle_outline),
                label: Text(
                  image.canBeMain
                      ? 'Make main picture'
                      : 'Show this as their picture',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
