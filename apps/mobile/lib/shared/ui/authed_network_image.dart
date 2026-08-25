import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/config/app_config.dart';
import '../api/api_client.dart';

/// An API-owned network image loaded with the signed-in user's bearer token.
///
/// The interface intentionally covers only the image behavior shared by the
/// app's authenticated thumbnails and artwork. More specialized viewers keep
/// owning their route, gesture, and resolved-header behavior themselves.
class AuthedNetworkImage extends ConsumerWidget {
  const AuthedNetworkImage({
    required this.url,
    required this.cacheBuster,
    this.fit,
    this.width,
    this.height,
    this.semanticLabel,
    this.loadingPlaceholder = const SizedBox.shrink(),
    this.errorPlaceholder = const SizedBox.shrink(),
    this.logicalDecodeWidth,
    this.transitionDuration,
    super.key,
  });

  /// An API-relative or absolute URL.
  final String url;

  /// A value for the `v` query parameter, or null for an immutable URL.
  ///
  /// This is required even though it is nullable so every caller makes its
  /// cache invalidation rule explicit.
  final String? cacheBuster;

  final BoxFit? fit;
  final double? width;
  final double? height;
  final String? semanticLabel;
  final Widget loadingPlaceholder;
  final Widget errorPlaceholder;

  /// Decode width in logical pixels. The image cache receives physical pixels.
  final double? logicalDecodeWidth;

  /// When set, switches from [loadingPlaceholder] to the decoded image with
  /// the same transition already used by image-heavy feature surfaces.
  final Duration? transitionDuration;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final headersValue = ref.watch(apiAuthHeadersProvider);
    return headersValue.when(
      data: (headers) {
        final uri = resolveAuthedImageUri(
          apiBaseUrl: ref.watch(appConfigProvider).apiBaseUrl,
          url: url,
          cacheBuster: cacheBuster,
        );
        final ratio = MediaQuery.devicePixelRatioOf(context);
        final cacheWidth = logicalDecodeWidth == null
            ? null
            : (logicalDecodeWidth! * ratio).round();

        return Image.network(
          uri.toString(),
          headers: headers,
          fit: fit,
          width: width,
          height: height,
          semanticLabel: semanticLabel,
          cacheWidth: cacheWidth,
          errorBuilder: (context, error, stackTrace) => errorPlaceholder,
          frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
            final loaded = wasSynchronouslyLoaded || frame != null;
            final duration = transitionDuration;
            if (duration == null) {
              return loaded ? child : loadingPlaceholder;
            }
            return AnimatedSwitcher(
              duration: duration,
              child: KeyedSubtree(
                key: ValueKey(loaded),
                child: loaded ? child : loadingPlaceholder,
              ),
            );
          },
        );
      },
      loading: () => loadingPlaceholder,
      error: (error, stackTrace) => errorPlaceholder,
    );
  }
}

/// Resolves [url] and adds an optional cache version without dropping any
/// query parameters already carried by the API URL.
Uri resolveAuthedImageUri({
  required Uri apiBaseUrl,
  required String url,
  required String? cacheBuster,
}) {
  final resolved = apiBaseUrl.resolve(url);
  if (cacheBuster == null) return resolved;

  return resolved.replace(
    queryParameters: <String, dynamic>{
      ...resolved.queryParametersAll,
      'v': cacheBuster,
    },
  );
}
