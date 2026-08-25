import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';

/// Fullscreen photo preview with pinch-zoom and a close control.
Future<void> showChatImagePreview({
  required BuildContext context,
  String? localPath,
  String? remoteUrl,
  Map<String, String>? headers,
  String? semanticLabel,
}) {
  return Navigator.of(context).push<void>(
    PageRouteBuilder<void>(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.92),
      barrierDismissible: true,
      pageBuilder: (context, animation, secondaryAnimation) {
        return FadeTransition(
          opacity: animation,
          child: _ChatImagePreviewPage(
            localPath: localPath,
            remoteUrl: remoteUrl,
            headers: headers,
            semanticLabel: semanticLabel,
          ),
        );
      },
    ),
  );
}

/// Opens a local file or downloads a remote attachment, then shares it so the
/// user can preview or save with the system sheet.
Future<void> openChatAttachment({
  required BuildContext context,
  required WidgetRef ref,
  required String name,
  String? localPath,
  String? remoteUrl,
  String? mimeType,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final path = await _resolveAttachmentPath(
      ref: ref,
      name: name,
      localPath: localPath,
      remoteUrl: remoteUrl,
    );
    if (path == null) {
      messenger.showAppSnackBar(
        const SnackBar(content: Text('This file is no longer available.')),
      );
      return;
    }
    await SharePlus.instance.share(
      ShareParams(
        title: name,
        subject: name,
        files: [XFile(path, mimeType: mimeType, name: name)],
        fileNameOverrides: [name],
      ),
    );
  } catch (error) {
    messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
  }
}

Future<String?> _resolveAttachmentPath({
  required WidgetRef ref,
  required String name,
  String? localPath,
  String? remoteUrl,
}) async {
  if (localPath != null && File(localPath).existsSync()) {
    return localPath;
  }
  final url = remoteUrl;
  if (url == null || url.isEmpty) return null;

  final directory = await getTemporaryDirectory();
  final safeName = name
      .replaceAll(RegExp(r'[/\\]+'), '-')
      .replaceAll(RegExp(r'[^A-Za-z0-9._ -]+'), '')
      .trim();
  final filename = safeName.isEmpty ? 'attachment' : safeName;
  final path = '${directory.path}/tomeza_chat_$filename';
  await ref.read(apiClientProvider).downloadFile(url, path);
  return path;
}

/// Resolves auth headers + absolute URI for a stored chat attachment URL.
({String uri, Map<String, String> headers})? resolveChatAssetUri({
  required WidgetRef ref,
  required String? remoteUrl,
}) {
  if (remoteUrl == null || remoteUrl.isEmpty) return null;
  final headers = ref.read(apiAuthHeadersProvider).value;
  if (headers == null) return null;
  final config = ref.read(appConfigProvider);
  return (
    uri: config.apiBaseUrl.resolve(remoteUrl).toString(),
    headers: headers,
  );
}

class _ChatImagePreviewPage extends StatelessWidget {
  const _ChatImagePreviewPage({
    this.localPath,
    this.remoteUrl,
    this.headers,
    this.semanticLabel,
  });

  final String? localPath;
  final String? remoteUrl;
  final Map<String, String>? headers;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).pop(),
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 4,
                  child: Center(child: _image()),
                ),
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: IconButton(
                tooltip: 'Close',
                style: IconButton.styleFrom(
                  foregroundColor: Colors.white,
                  backgroundColor: Colors.black38,
                ),
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _image() {
    final path = localPath;
    if (path != null && File(path).existsSync()) {
      return Image.file(
        File(path),
        fit: BoxFit.contain,
        semanticLabel: semanticLabel,
        errorBuilder: (_, _, _) => _remoteOrError(),
      );
    }
    return _remoteOrError();
  }

  Widget _remoteOrError() {
    final url = remoteUrl;
    if (url == null) {
      return const Icon(
        Icons.broken_image_outlined,
        color: Colors.white70,
        size: 48,
      );
    }
    return Image.network(
      url,
      headers: headers,
      fit: BoxFit.contain,
      semanticLabel: semanticLabel,
      errorBuilder: (_, _, _) => const Icon(
        Icons.broken_image_outlined,
        color: Colors.white70,
        size: 48,
      ),
    );
  }
}
