import 'package:flutter/foundation.dart';

/// The message a reply points at, snapshotted when the reply is sent.
///
/// The excerpt travels with the reply rather than being looked up later: both
/// transcripts prune older turns — project chat paginates and the creation tree
/// folds its oldest turns into a summary — so resolving by id alone would
/// eventually render nothing. The id lets the composer scroll back to the
/// source while that turn is still in the transcript.
///
/// Shared by both chat surfaces. The widgets that draw it live in
/// `presentation/chat_reply_quote.dart`, which re-exports this type.
@immutable
class ChatReplyTarget {
  const ChatReplyTarget({
    required this.messageId,
    required this.role,
    required this.excerpt,
  });

  /// Longest excerpt the server will store; clipping to the same length here
  /// keeps an optimistic message identical to the one that comes back.
  static const excerptMax = 240;

  final String messageId;

  /// 'user' or 'assistant'.
  final String role;
  final String excerpt;

  bool get isUser => role == 'user';

  /// Builds the snapshot from the message being replied to, or null when there
  /// is nothing quotable (an attachment-only turn, or an unsent message).
  static ChatReplyTarget? from({
    required String? messageId,
    required String role,
    required String content,
  }) {
    final id = messageId?.trim() ?? '';
    final excerpt = content.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (id.isEmpty || excerpt.isEmpty) return null;
    return ChatReplyTarget(
      messageId: id,
      role: role == 'user' ? 'user' : 'assistant',
      excerpt: excerpt.length <= excerptMax
          ? excerpt
          : '${excerpt.substring(0, excerptMax).trimRight()}...',
    );
  }

  static ChatReplyTarget? fromJson(Object? json) {
    if (json is! Map) return null;
    final map = json.cast<String, dynamic>();
    final messageId = map['messageId'];
    final excerpt = map['excerpt'];
    if (messageId is! String || excerpt is! String) return null;
    return ChatReplyTarget.from(
      messageId: messageId,
      role: map['role'] is String ? map['role'] as String : 'assistant',
      content: excerpt,
    );
  }

  Map<String, dynamic> toJson() => {
    'messageId': messageId,
    'role': role,
    'excerpt': excerpt,
  };
}
