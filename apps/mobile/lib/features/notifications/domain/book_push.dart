/// What a book push says — the data of one FCM message from the server's push
/// sweep (`apps/api/src/push/bookPushMessages.ts`).
///
/// The keys and kind names are a wire contract: every installed build keeps
/// the spelling it shipped with. A kind this build does not know parses to
/// null and is ignored, which is what lets the server add one.
enum BookPushKind {
  progress('book_progress'),
  ready('book_ready'),
  failed('book_failed'),
  clear('book_clear');

  const BookPushKind(this.wire);

  final String wire;

  static BookPushKind? fromWire(Object? value) {
    for (final kind in values) {
      if (kind.wire == value) return kind;
    }
    return null;
  }
}

class BookPush {
  const BookPush({
    required this.kind,
    required this.projectId,
    required this.sentAt,
    required this.title,
    required this.body,
    this.percent,
  });

  final BookPushKind kind;
  final String projectId;

  /// When the server claimed this message, in ms. FCM does not keep order, so
  /// a message no newer than the last one shown for the book is dropped.
  final int sentAt;

  final String title;
  final String body;

  /// 0–100, on progress messages only.
  final int? percent;

  /// FCM data values are always strings; anything else is a message this
  /// build cannot trust, and null.
  static BookPush? fromData(Map<String, dynamic> data) {
    final kind = BookPushKind.fromWire(data['kind']);
    final projectId = data['projectId'];
    final sentAt = int.tryParse('${data['sentAt'] ?? ''}');
    if (kind == null || projectId is! String || projectId.isEmpty) return null;
    if (sentAt == null) return null;
    final percent = int.tryParse('${data['percent'] ?? ''}');
    return BookPush(
      kind: kind,
      projectId: projectId,
      sentAt: sentAt,
      title: _text(data['title']),
      body: _text(data['body']),
      percent: percent?.clamp(0, 100),
    );
  }

  static String _text(Object? value) => value is String ? value : '';
}

/// The one notification slot a book has, shared by its progress bar and the
/// message that ends it, so "ready" replaces the bar rather than joining it.
///
/// FNV-1a over the id rather than `String.hashCode`: the background isolate
/// that shows a notification and the app that later clears it must agree on
/// the number, and Dart does not promise `hashCode` is stable across runs.
int bookNotificationId(String projectId) {
  var hash = 0x811c9dc5;
  for (final unit in projectId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  // Android takes a signed 32-bit id; keep it positive and clear of 0.
  return (hash & 0x7ffffffe) + 1;
}
