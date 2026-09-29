/// Where the Writing Studio lives for one book, and the small helpers every
/// door into it shares.
library;

/// The Studio route for [projectId]: `/projects/<id>/write`, opened at
/// [chapterId] when given, and straight into the publish sheet when [publish].
String studioLocation(
  String projectId, {
  String? chapterId,
  bool publish = false,
}) {
  final query = <String, String>{
    if (chapterId != null && chapterId.isNotEmpty) 'chapter': chapterId,
    if (publish) 'publish': '1',
  };
  return Uri(
    path: '/projects/$projectId/write',
    queryParameters: query.isEmpty ? null : query,
  ).toString();
}

int _requestSequence = 0;

/// A fresh idempotency key for one Studio request. A caller keeps the same key
/// across retries of the same request, so the server can replay it.
String studioRequestId(String prefix) {
  _requestSequence += 1;
  return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$_requestSequence';
}
