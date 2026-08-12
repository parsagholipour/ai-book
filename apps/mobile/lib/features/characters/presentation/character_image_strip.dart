import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/character_image_models.dart';
import 'character_network_image.dart';

const double _tile = 84;
const double _row = 96;

/// Every picture this character has ever had, newest first.
///
/// Before this, a redraw destroyed the drawing it replaced: the filename was
/// derived from the character id alone, so each new one truncated the last in
/// place. The strip is the reader-facing half of fixing that — a picture they
/// liked better is still here, and one tap puts it back in charge of what their
/// books draw.
class CharacterImageStrip extends StatelessWidget {
  const CharacterImageStrip({
    required this.images,
    required this.loading,
    required this.pendingUpload,
    required this.uploadProgress,
    required this.drawingInProgress,
    required this.onOpen,
    required this.onOptions,
    required this.onAdd,
    super.key,
  });

  final List<CharacterImage> images;
  final bool loading;
  final Uint8List? pendingUpload;
  final double? uploadProgress;

  /// A drawing is on its way; it gets a place in the strip before it exists, so
  /// the reader can see where it will land.
  final bool drawingInProgress;

  final void Function(int index) onOpen;
  final void Function(CharacterImage image) onOptions;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final empty = images.isEmpty && pendingUpload == null && !drawingInProgress;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSectionHeader(
          title: 'Pictures',
          subtitle: empty
              ? 'Add a photo, or have one drawn.'
              : 'Newest first. The main one is what your books draw from. '
                    'The last 20 are kept.',
          action: empty
              ? null
              : IconButton(
                  key: const ValueKey('character-strip-add'),
                  tooltip: 'Add a picture',
                  onPressed: onAdd,
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                ),
        ),
        const SizedBox(height: AppSpacing.xs),
        SizedBox(
          height: _row,
          child: loading && images.isEmpty
              ? _skeletons()
              : ListView(
                  scrollDirection: Axis.horizontal,
                  // Bleeds off both edges so the row reads as scrollable.
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  children: [
                    if (pendingUpload != null) ...[
                      _PendingTile(
                        bytes: pendingUpload!,
                        progress: uploadProgress,
                      ),
                      const SizedBox(width: AppSpacing.xs + 2),
                    ],
                    if (drawingInProgress) ...[
                      const _DrawingTile(),
                      const SizedBox(width: AppSpacing.xs + 2),
                    ],
                    for (var index = 0; index < images.length; index++) ...[
                      AppEntrance(
                        index: index,
                        child: _PictureTile(
                          key: ValueKey('character-image-tile-${images[index].id}'),
                          image: images[index],
                          position: index + 1,
                          total: images.length,
                          onTap: () {
                            AppHaptics.tap();
                            onOpen(index);
                          },
                          onLongPress: () {
                            AppHaptics.longPress();
                            onOptions(images[index]);
                          },
                        ),
                      ),
                      const SizedBox(width: AppSpacing.xs + 2),
                    ],
                    // Last, not first: a leading "+" would push the newest
                    // picture off the edge of the screen.
                    _AddTile(wide: empty, onTap: onAdd),
                  ],
                ),
        ),
        if (!empty) ...[
          const SizedBox(height: AppSpacing.xxs),
          Text(
            'Hold a picture for more.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }

  Widget _skeletons() {
    return ListView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      children: [
        for (var index = 0; index < 3; index++) ...[
          const _TileFrame(child: _TileShimmer()),
          const SizedBox(width: AppSpacing.xs + 2),
        ],
      ],
    );
  }
}

/// One retained picture.
///
/// Nothing inside a tile is text. The row's height is fixed, and a label in
/// here would reflow it at a 1.6 text scale — so the badges are icons and every
/// word lives in [Semantics].
class _PictureTile extends StatelessWidget {
  const _PictureTile({
    required this.image,
    required this.position,
    required this.total,
    required this.onTap,
    required this.onLongPress,
    super.key,
  });

  final CharacterImage image;
  final int position;
  final int total;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  String get _kindLabel {
    if (image.source == CharacterImageSource.generated) return 'AI illustration';
    return image.isOwnArtwork ? 'Your artwork' : 'Your photo';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      selected: image.isMain,
      label:
          '$_kindLabel, $position of $total'
          '${image.isMain ? ', main picture' : ''}. Double tap to view.',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        onLongPress: onLongPress,
        child: ExcludeSemantics(
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              _TileFrame(
                // The main marker is two cues on purpose: a ring alone
                // disappears against a dark photograph, and a chip alone
                // competes with the source badge in the other corner.
                border: image.isMain
                    ? Border.all(color: colors.primary, width: 2.5)
                    : null,
                child: CharacterNetworkImage(
                  url: image.url,
                  decodeWidth: _tile,
                ),
              ),
              if (image.isMain)
                PositionedDirectional(
                  top: -4,
                  end: -4,
                  child: _Badge(
                    icon: Icons.check,
                    background: colors.primary,
                    foreground: colors.onPrimary,
                  ),
                ),
              PositionedDirectional(
                bottom: -4,
                end: -4,
                child: _sourceBadge(colors),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sourceBadge(ColorScheme colors) {
    if (image.source == CharacterImageSource.generated) {
      return _Badge(
        icon: Icons.auto_awesome,
        background: colors.secondaryContainer,
        foreground: colors.onSecondaryContainer,
      );
    }
    if (image.isOwnArtwork) {
      return _Badge(
        icon: Icons.brush_outlined,
        background: colors.tertiaryContainer,
        foreground: colors.onTertiaryContainer,
      );
    }
    return _Badge(
      icon: Icons.photo_camera_outlined,
      background: colors.surfaceContainerHighest,
      foreground: colors.onSurfaceVariant,
    );
  }
}

class _PendingTile extends StatelessWidget {
  const _PendingTile({required this.bytes, required this.progress});

  final Uint8List bytes;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Uploading your picture',
      child: _TileFrame(
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.memory(bytes, fit: BoxFit.cover),
            ColoredBox(
              color: Theme.of(
                context,
              ).colorScheme.surface.withValues(alpha: 0.45),
            ),
            Center(
              child: SizedBox.square(
                dimension: 26,
                child: CircularProgressIndicator(strokeWidth: 3, value: progress),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DrawingTile extends StatelessWidget {
  const _DrawingTile();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Drawing the illustration',
      child: const _TileFrame(
        child: Stack(
          fit: StackFit.expand,
          children: [
            _TileShimmer(),
            Center(
              child: SizedBox.square(
                dimension: 22,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AddTile extends StatelessWidget {
  const _AddTile({required this.wide, required this.onTap});

  final bool wide;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context);
    return Semantics(
      button: true,
      label: 'Add a picture',
      child: GestureDetector(
        key: const ValueKey('character-strip-add-tile'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          AppHaptics.tap();
          onTap();
        },
        child: ExcludeSemantics(
          child: Container(
            width: wide ? 190 : _tile,
            height: _tile,
            decoration: BoxDecoration(
              color: colors.surfaceContainerLow,
              borderRadius: BorderRadius.circular(AppRadii.control),
              border: Border.all(color: colors.outlineVariant),
            ),
            child: wide
                ? Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.add_photo_alternate_outlined, color: colors.primary),
                      const SizedBox(width: AppSpacing.xs),
                      Flexible(
                        child: Text(
                          'Add a picture',
                          style: theme.textTheme.labelLarge?.copyWith(
                            color: colors.primary,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  )
                : Icon(Icons.add_photo_alternate_outlined, color: colors.primary),
          ),
        ),
      ),
    );
  }
}

class _TileFrame extends StatelessWidget {
  const _TileFrame({required this.child, this.border});

  final Widget child;
  final BoxBorder? border;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: AppMotion.fast,
      curve: AppMotion.standard,
      width: _tile,
      height: _tile,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: border,
      ),
      padding: EdgeInsets.all(border == null ? 0 : 3),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.control - 2),
        child: child,
      ),
    );
  }
}

class _TileShimmer extends StatelessWidget {
  const _TileShimmer();

  @override
  Widget build(BuildContext context) {
    return AppShimmer(
      child: ColoredBox(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({
    required this.icon,
    required this.background,
    required this.foreground,
  });

  final IconData icon;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        shape: BoxShape.circle,
        border: Border.all(color: Theme.of(context).colorScheme.surface, width: 2),
      ),
      child: Padding(
        padding: const EdgeInsets.all(3),
        child: Icon(icon, size: 12, color: foreground),
      ),
    );
  }
}
