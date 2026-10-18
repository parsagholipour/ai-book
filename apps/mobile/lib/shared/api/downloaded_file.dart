import 'package:dio/dio.dart';

/// What the server said about the bytes a download just wrote.
///
/// Only the headers, and only because one download needs them: a compiled
/// export is served from a URL that every compile of the book publishes over,
/// so the response — not the request, and not a status read taken before it —
/// is the only thing that can say which compile answered. See
/// `ExportProvenance`.
class DownloadedFile {
  const DownloadedFile({required this.headers});

  /// Response headers, names lower-cased, first value only.
  final Map<String, String> headers;

  String? header(String name) => headers[name.toLowerCase()];

  /// The length the response declared, or null when it declared none.
  int? get contentLength => int.tryParse(header('content-length') ?? '');

  static DownloadedFile fromResponse(Response<dynamic> response) {
    return DownloadedFile(
      headers: {
        for (final entry in response.headers.map.entries)
          if (entry.value.isNotEmpty)
            entry.key.toLowerCase(): entry.value.first,
      },
    );
  }
}
