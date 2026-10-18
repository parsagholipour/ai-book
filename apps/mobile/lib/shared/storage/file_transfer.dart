import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:share_plus/share_plus.dart';

import 'app_files.dart';

/// Dio's native download writes a path. Browsers receive bytes instead, while
/// preserving response headers used to verify export revisions and lengths.
Future<Response<dynamic>> downloadToFile(
  Dio dio,
  String url,
  String path, {
  Options? options,
  ProgressCallback? onReceiveProgress,
  CancelToken? cancelToken,
}) async {
  if (!kIsWeb) {
    return dio.download(
      url,
      path,
      options: options,
      onReceiveProgress: onReceiveProgress,
      cancelToken: cancelToken,
    );
  }
  final response = await dio.get<List<int>>(
    url,
    options: (options ?? Options()).copyWith(responseType: ResponseType.bytes),
    onReceiveProgress: onReceiveProgress,
    cancelToken: cancelToken,
  );
  final file = appFile(path);
  await file.parent.create(recursive: true);
  await file.writeAsBytes(response.data!);
  return response;
}

XFile shareableFile(String path, {String? mimeType, String? name}) => kIsWeb
    ? XFile.fromData(
        appFile(path).readAsBytesSync(),
        mimeType: mimeType,
        name: name ?? path.split('/').last,
      )
    : XFile(path, mimeType: mimeType, name: name);
