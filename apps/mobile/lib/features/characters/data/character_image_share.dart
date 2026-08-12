import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_client.dart';

/// Downloads one retained picture and hands it to the system share sheet.
///
/// Character files are behind the bearer token, so the bytes have to come
/// through the API client rather than the share sheet fetching a URL — the
/// same shape the chat attachment share uses, but not a call into it, because
/// that one resolves project asset headers.
Future<void> shareCharacterImage({
  required ApiClient apiClient,
  required String url,
  required String imageId,
}) async {
  final directory = await getTemporaryDirectory();
  final path = '${directory.path}/tomeza_character_$imageId.jpg';
  await apiClient.downloadFile(url, path);
  await SharePlus.instance.share(
    ShareParams(files: [XFile(path, mimeType: 'image/jpeg')]),
  );
}
