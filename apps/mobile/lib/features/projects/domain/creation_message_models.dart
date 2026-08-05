import 'project_models.dart';

/// What a creation-chat message is made of: the message itself, the grounded
/// web research an assistant turn can carry, and the attachments a turn refers
/// to. Split out of `creation_models.dart`, which holds the session and draft
/// side of the same conversation.

/// Local-only delivery state for optimistic creation chat messages.
enum CreationMessageSendStatus { sending, sent, failed }

class MobileCreationMessage {
  const MobileCreationMessage({
    required this.role,
    required this.content,
    this.attachments = const [],
    this.research,
    this.createdAt,
    this.sendStatus = CreationMessageSendStatus.sent,
    this.sendError,
    this.localId,
    this.includedSourceNotes = false,
    this.id,
    this.parentId,
    this.branch,
    this.requestId,
  });

  final String role;
  final String content;
  final List<MobileCreationMessageAttachment> attachments;
  final MobileCreationResearch? research;

  /// Server id; null for optimistic messages that were not persisted yet.
  final String? id;

  /// Id of the preceding message in the conversation tree.
  final String? parentId;

  /// Position among sibling branches; null when this message has no siblings.
  final MobileProjectChatBranch? branch;

  /// Client-generated idempotency key retained for failed-send retries.
  final String? requestId;

  /// Present for server messages; optimistic local messages may set this too.
  final DateTime? createdAt;

  /// Delivery state for optimistic user messages (not persisted by the API).
  final CreationMessageSendStatus sendStatus;
  final String? sendError;

  /// Stable id for optimistic messages so retry/dismiss can target them.
  final String? localId;

  /// True when this optimistic/user turn included pasted source notes.
  final bool includedSourceNotes;

  bool get isUser => role == 'user';

  bool get hasAttachments => attachments.isNotEmpty;

  bool get isFailedSend => sendStatus == CreationMessageSendStatus.failed;

  MobileCreationMessage copyWith({
    CreationMessageSendStatus? sendStatus,
    Object? sendError = _messageSentinel,
    DateTime? createdAt,
    bool? includedSourceNotes,
  }) {
    return MobileCreationMessage(
      role: role,
      content: content,
      attachments: attachments,
      research: research,
      createdAt: createdAt ?? this.createdAt,
      sendStatus: sendStatus ?? this.sendStatus,
      sendError: sendError == _messageSentinel
          ? this.sendError
          : sendError as String?,
      localId: localId,
      includedSourceNotes: includedSourceNotes ?? this.includedSourceNotes,
      id: id,
      parentId: parentId,
      branch: branch,
      requestId: requestId,
    );
  }

  static const _messageSentinel = Object();

  factory MobileCreationMessage.fromJson(Map<String, dynamic> json) {
    final attachments = json['attachments'] as List<dynamic>? ?? const [];
    final createdAtRaw = json['createdAt'];
    final branch = json['branch'];
    final research = json['research'];
    return MobileCreationMessage(
      role: json['role'] as String,
      content: json['content'] as String,
      attachments: attachments
          .map(
            (attachment) => MobileCreationMessageAttachment.fromJson(
              attachment as Map<String, dynamic>,
            ),
          )
          .toList(),
      research: research is Map
          ? MobileCreationResearch.fromJson(Map<String, dynamic>.from(research))
          : null,
      createdAt: createdAtRaw is String
          ? DateTime.tryParse(createdAtRaw)
          : null,
      id: json['id'] as String?,
      parentId: json['parentId'] as String?,
      requestId: json['requestId'] as String?,
      branch: branch is Map<String, dynamic>
          ? MobileProjectChatBranch.fromJson(branch)
          : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'role': role,
      'content': content,
      if (attachments.isNotEmpty)
        'attachments': attachments
            .map((attachment) => attachment.toJson())
            .toList(),
      if (research != null) 'research': research!.toJson(),
      if (createdAt != null) 'createdAt': createdAt!.toIso8601String(),
      if (id != null) 'id': id,
      if (parentId != null) 'parentId': parentId,
      if (requestId != null) 'requestId': requestId,
    };
  }
}

const _groundingRedirectHost = 'vertexaisearch.cloud.google.com';

class MobileCreationResearchSource {
  const MobileCreationResearchSource({
    required this.title,
    required this.summary,
    this.url,
    this.publishedAt,
  });

  final String title;
  final String summary;
  final String? url;
  final String? publishedAt;

  Uri? get uri {
    final parsed = Uri.tryParse(url ?? '');
    if (parsed == null ||
        (parsed.scheme != 'https' && parsed.scheme != 'http')) {
      return null;
    }
    return parsed;
  }

  /// The publisher to name beside the title, or null when there is none worth
  /// naming. Grounded search cites every page through a Google redirect; the
  /// server unwraps those as the research arrives, but a chat held from before
  /// that still carries one, and labelling a source `vertexaisearch.cloud.
  /// google.com` tells the reader nothing about who wrote it.
  String? get displayHost {
    final host = uri?.host.toLowerCase();
    if (host == null ||
        host.isEmpty ||
        host == _groundingRedirectHost ||
        host.endsWith('.$_groundingRedirectHost')) {
      return null;
    }
    return host.replaceFirst(RegExp(r'^www\.'), '');
  }

  factory MobileCreationResearchSource.fromJson(Map<String, dynamic> json) {
    return MobileCreationResearchSource(
      title: json['title'] as String? ?? 'Source',
      summary: json['summary'] as String? ?? '',
      url: json['url'] as String?,
      publishedAt: json['publishedAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'title': title,
    'summary': summary,
    if (url != null) 'url': url,
    if (publishedAt != null) 'publishedAt': publishedAt,
  };
}

class MobileCreationResearch {
  const MobileCreationResearch({
    required this.query,
    required this.summary,
    required this.sources,
  });

  final String query;
  final String summary;
  final List<MobileCreationResearchSource> sources;

  factory MobileCreationResearch.fromJson(Map<String, dynamic> json) {
    final sources = json['sources'] as List<dynamic>? ?? const [];
    return MobileCreationResearch(
      query: json['query'] as String? ?? '',
      summary: json['summary'] as String? ?? '',
      sources: sources
          .whereType<Map>()
          .map(
            (source) => MobileCreationResearchSource.fromJson(
              Map<String, dynamic>.from(source),
            ),
          )
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'query': query,
    'summary': summary,
    'sources': sources.map((source) => source.toJson()).toList(),
  };
}

/// Reference from a chat message to a file uploaded into the conversation.
class MobileCreationMessageAttachment {
  const MobileCreationMessageAttachment({
    required this.id,
    required this.kind,
    required this.name,
  });

  final String id;
  final String kind;
  final String name;

  bool get isPhoto => kind == 'photo';

  factory MobileCreationMessageAttachment.fromJson(Map<String, dynamic> json) {
    return MobileCreationMessageAttachment(
      id: json['id'] as String,
      kind: json['kind'] as String? ?? 'document',
      name: json['name'] as String? ?? 'attachment',
    );
  }

  Map<String, dynamic> toJson() {
    return {'id': id, 'kind': kind, 'name': name};
  }
}

/// A file uploaded into the creation chat, already read by the server.
class MobileCreationAttachment {
  const MobileCreationAttachment({
    required this.id,
    required this.kind,
    required this.name,
    required this.sizeBytes,
    this.summary = '',
    this.pages,
    this.truncated = false,
    this.url,
    this.sessionRevision,
  });

  final String id;
  final String kind;
  final String name;
  final int sizeBytes;
  final String summary;
  final int? pages;
  final bool truncated;

  /// API path serving the stored original file; null for uploads made before
  /// server-side storage existed or after the retention window.
  final String? url;
  final int? sessionRevision;

  bool get isPhoto => kind == 'photo';

  factory MobileCreationAttachment.fromJson(Map<String, dynamic> json) {
    return MobileCreationAttachment(
      id: json['id'] as String,
      kind: json['kind'] as String? ?? 'document',
      name: json['name'] as String? ?? 'attachment',
      sizeBytes: json['sizeBytes'] as int? ?? 0,
      summary: json['summary'] as String? ?? '',
      pages: json['pages'] as int?,
      truncated: json['truncated'] as bool? ?? false,
      url: json['url'] as String?,
      sessionRevision: json['sessionRevision'] as int?,
    );
  }
}
