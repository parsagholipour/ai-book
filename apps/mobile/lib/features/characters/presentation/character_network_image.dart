import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/motion.dart';
import '../data/characters_repository.dart';

/// One retained picture, fetched with the mobile bearer token.
///
/// Character files are served behind auth, so they cannot be plain network
/// images; this is the same pattern `CharacterAvatar` and the book cover use,
/// in one place because the header, the strip and the viewer all need it.
///
/// [decodeWidth] is not an optimisation to skip. A character can hold twenty
/// retained pictures, each up to 1600px, and every one of them decodes to
/// several megabytes of RGBA — a strip of full-size decodes walks straight into
/// Flutter's image cache ceiling and starts evicting the pictures it just drew.
class CharacterNetworkImage extends ConsumerWidget {
  const CharacterNetworkImage({
    required this.url,
    this.fit = BoxFit.cover,
    this.decodeWidth,
    this.semanticLabel,
    this.placeholder,
    this.errorPlaceholder,
    super.key,
  });

  /// An API-relative path (`/api/mobile/characters/…`). Image URLs carry no
  /// cache-busting query: one image id is one set of bytes for good.
  final String url;
  final BoxFit fit;
  final double? decodeWidth;
  final String? semanticLabel;
  final Widget? placeholder;
  final Widget? errorPlaceholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final waiting = placeholder ?? const _PictureShimmer();
    final broken = errorPlaceholder ?? const _BrokenPicture();

    final headers = ref.watch(characterAssetHeadersProvider).value;
    if (headers == null) {
      return waiting;
    }
    final uri = ref.watch(appConfigProvider).apiBaseUrl.resolve(url).toString();
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final cacheWidth = decodeWidth == null
        ? null
        : (decodeWidth! * ratio).round();

    return Image.network(
      uri,
      headers: headers,
      fit: fit,
      cacheWidth: cacheWidth,
      semanticLabel: semanticLabel,
      errorBuilder: (context, error, stackTrace) => broken,
      frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
        if (wasSynchronouslyLoaded || frame != null) {
          return AnimatedSwitcher(duration: AppMotion.medium, child: child);
        }
        return waiting;
      },
    );
  }
}

class _PictureShimmer extends StatelessWidget {
  const _PictureShimmer();

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

/// What a picture whose file is gone looks like.
///
/// It stays a solid, tappable plate rather than collapsing: a row whose write
/// never landed is exactly the entry the reader needs to be able to reach in
/// order to delete it.
class _BrokenPicture extends StatelessWidget {
  const _BrokenPicture();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: Icon(
          Icons.broken_image_outlined,
          color: colors.onSurfaceVariant,
          semanticLabel: "Couldn't load this picture",
        ),
      ),
    );
  }
}
