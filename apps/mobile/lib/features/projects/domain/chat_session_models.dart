import 'creation_models.dart' show MobileCreationOutput;

class MobileChatSessionPage {
  const MobileChatSessionPage({required this.sessions, this.nextCursor});

  final List<MobileChatSession> sessions;
  final String? nextCursor;

  factory MobileChatSessionPage.fromJson(Map<String, dynamic> json) {
    return MobileChatSessionPage(
      sessions: (json['sessions'] as List<dynamic>)
          .map(
            (item) => MobileChatSession.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      nextCursor: json['nextCursor'] as String?,
    );
  }
}

class MobileChatSession {
  const MobileChatSession({
    required this.draftId,
    required this.title,
    required this.preview,
    required this.messageCount,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    DateTime? lastMessageAt,
    this.archived = false,
    this.outputs = const [],
    this.createdProjectId,
    this.activeProjectId,
  }) : lastMessageAt = lastMessageAt ?? updatedAt;

  final String draftId;
  final String title;
  final String preview;
  final int messageCount;
  final String status;
  final bool archived;
  final String? createdProjectId;
  final String? activeProjectId;
  final List<MobileCreationOutput> outputs;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Time of the last conversation turn; unlike [updatedAt] it is not bumped
  /// by builds or other background updates, so lists order by it.
  final DateTime lastMessageAt;

  bool get isActive => status == 'ACTIVE';

  factory MobileChatSession.fromJson(Map<String, dynamic> json) {
    final outputs = json['outputs'] as List<dynamic>? ?? const [];
    return MobileChatSession(
      draftId: json['draftId'] as String,
      title: json['title'] as String,
      preview: json['preview'] as String,
      messageCount: json['messageCount'] as int,
      status: json['status'] as String,
      archived: json['archived'] as bool? ?? false,
      createdProjectId: json['createdProjectId'] as String?,
      activeProjectId:
          json['activeProjectId'] as String? ??
          json['createdProjectId'] as String?,
      outputs: outputs
          .map(
            (output) =>
                MobileCreationOutput.fromJson(output as Map<String, dynamic>),
          )
          .toList(),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      lastMessageAt: json['lastMessageAt'] is String
          ? DateTime.parse(json['lastMessageAt'] as String)
          : null,
    );
  }
}
