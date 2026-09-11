import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/creation_message_models.dart';
import '../domain/creation_models.dart';

abstract interface class CreationRepository {
  Future<List<MobileChatSession>> listSessions();

  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  });

  Future<List<MobileChatSession>> listArchivedSessions();

  Future<void> setSessionArchived({
    required String draftId,
    required bool archived,
  });

  Future<MobileCreationDraft?> getActiveDraft();

  Future<MobileCreationDraft> createDraft(MobileCreationDraftPayload payload);

  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  });

  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  );

  Future<MobileCreationFinalizeResponse> finalizeDraft(String id);

  Future<MobileCreationConversationResponse> resumeConversation();

  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  );

  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    List<String>? mentionedCharacterIds,
    String? requestId,
  });

  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? mentionedCharacterIds,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? editMessageId,
    String? replyToMessageId,
    String? requestId,
    int? expectedRevision,
    bool skippedQuestion = false,
  });

  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  });

  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
    int? expectedRevision,
  });

  Future<int?> deleteAttachment({
    required String draftId,
    required String attachmentId,
    int? expectedRevision,
  });

  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    String? requestId,
    int? expectedRevision,
  });

  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  });

  Future<void> renameSession({
    required String draftId,
    required String title,
    int? expectedRevision,
  });

  Future<void> deleteSession(String draftId);
}

class MobileCreationRepository implements CreationRepository {
  const MobileCreationRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<MobileChatSession>> listSessions() =>
      _listSessions(archived: false);

  @override
  Future<MobileChatSessionPage> listSessionsPage({
    String? cursor,
    String query = '',
  }) async {
    final path = Uri(
      path: '/api/mobile/creation-sessions',
      queryParameters: {
        'limit': '30',
        'cursor': ?cursor,
        if (query.isNotEmpty) 'q': query,
      },
    ).toString();
    return MobileChatSessionPage.fromJson(await apiClient.getMap(path));
  }

  @override
  Future<List<MobileChatSession>> listArchivedSessions() =>
      _listSessions(archived: true);

  Future<List<MobileChatSession>> _listSessions({
    required bool archived,
  }) async {
    final data = await apiClient.getMap(
      '/api/mobile/creation-sessions${archived ? '?archived=true' : ''}',
    );
    final list = data['sessions'] as List<dynamic>;
    final sessions = list
        .cast<Map<String, dynamic>>()
        .map(MobileChatSession.fromJson)
        .toList();
    // Most recent conversation first, even against older servers that order
    // by row updatedAt (which builds and copies bump without a new message).
    sessions.sort((a, b) => b.lastMessageAt.compareTo(a.lastMessageAt));
    return sessions;
  }

  @override
  Future<void> setSessionArchived({
    required String draftId,
    required bool archived,
  }) async {
    await apiClient.patchJson(
      '/api/mobile/creation-sessions/$draftId/archive',
      data: {'archived': archived},
    );
  }

  @override
  Future<MobileCreationDraft?> getActiveDraft() async {
    final data = await apiClient.getMap('/api/mobile/creation-drafts/active');
    final draft = data['draft'];
    return draft == null
        ? null
        : MobileCreationDraft.fromJson(draft as Map<String, dynamic>);
  }

  @override
  Future<MobileCreationDraft> createDraft(
    MobileCreationDraftPayload payload,
  ) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-drafts',
      data: payload.toJson(),
    );
    return _draftFromResponse(data);
  }

  @override
  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  }) async {
    final response = await apiClient.patchJson(
      '/api/mobile/creation-drafts/$id',
      data: payload.toJson(),
    );
    return _draftFromResponse(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  ) async {
    final data = await apiClient.postMap(
      '/api/mobile/book-advisor',
      data: payload.toJson(),
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileBookAdvisorResponse.fromJson(
      data['advisor'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-drafts/$id/create-project',
      data: const <String, dynamic>{},
    );
    return MobileCreationFinalizeResponse.fromJson(data);
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    final data = await apiClient.getMap('/api/mobile/creation-sessions/active');
    return MobileCreationConversationResponse.fromJson(data);
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    final data = await apiClient.getMap(
      '/api/mobile/creation-sessions/$draftId',
    );
    return MobileCreationConversationResponse.fromJson(data);
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    List<String>? mentionedCharacterIds,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-sessions',
      data: <String, dynamic>{
        'message': ?message,
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        if (mentionedCharacterIds != null && mentionedCharacterIds.isNotEmpty)
          'mentionedCharacterIds': mentionedCharacterIds,
        'requestId': ?requestId,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileCreationConversationResponse.fromJson(data);
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? mentionedCharacterIds,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? editMessageId,
    String? replyToMessageId,
    String? requestId,
    int? expectedRevision,
    bool skippedQuestion = false,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-sessions/$draftId/messages',
      data: <String, dynamic>{
        'message': message,
        if (attachmentIds != null && attachmentIds.isNotEmpty)
          'attachmentIds': attachmentIds,
        if (mentionedCharacterIds != null && mentionedCharacterIds.isNotEmpty)
          'mentionedCharacterIds': mentionedCharacterIds,
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        'editMessageId': ?editMessageId,
        'replyToMessageId': ?replyToMessageId,
        'requestId': ?requestId,
        'expectedRevision': ?expectedRevision,
        if (skippedQuestion) 'skippedQuestion': true,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileCreationConversationResponse.fromJson(data);
  }

  @override
  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-sessions/$draftId/branches',
      data: <String, dynamic>{
        'messageId': messageId,
        'direction': direction,
        'expectedRevision': ?expectedRevision,
      },
    );
    return MobileCreationConversationResponse.fromJson(data);
  }

  @override
  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
    int? expectedRevision,
  }) async {
    final response = await apiClient.postBytes(
      '/api/mobile/creation-sessions/$draftId/attachments',
      bytes: bytes,
      queryParameters: {
        'filename': filename,
        'async': 'true',
        if (mimeType != null && mimeType.isNotEmpty) 'mimeType': mimeType,
        'expectedRevision': ?expectedRevision?.toString(),
      },
      onSendProgress: onProgress,
    );
    final data = response.data as Map<String, dynamic>;
    return MobileCreationAttachment.fromJson({
      ...(data['attachment'] as Map<String, dynamic>),
      'sessionRevision': data['revision'],
    });
  }

  @override
  Future<int?> deleteAttachment({
    required String draftId,
    required String attachmentId,
    int? expectedRevision,
  }) async {
    final response = await apiClient.deleteJson(
      '/api/mobile/creation-sessions/$draftId/attachments/$attachmentId${expectedRevision == null ? '' : '?expectedRevision=$expectedRevision'}',
    );
    final data = response.data;
    return data is Map<String, dynamic> ? data['revision'] as int? : null;
  }

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    String? requestId,
    int? expectedRevision,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-sessions/$draftId/build',
      data: <String, dynamic>{
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        'language': ?language,
        'requestId': ?requestId,
        'expectedRevision': ?expectedRevision,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileCreationFinalizeResponse.fromJson(data);
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/creation-sessions/$draftId/preflight',
      data: <String, dynamic>{
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        'language': ?language,
      },
      receiveTimeout: llmReceiveTimeout,
    );
    return MobileCreationBuildPreflight.fromJson(data);
  }

  @override
  Future<void> renameSession({
    required String draftId,
    required String title,
    int? expectedRevision,
  }) async {
    await apiClient.patchJson(
      '/api/mobile/creation-sessions/$draftId/title',
      data: <String, dynamic>{
        'title': title,
        'expectedRevision': ?expectedRevision,
      },
    );
  }

  @override
  Future<void> deleteSession(String draftId) async {
    await apiClient.deleteJson('/api/mobile/creation-sessions/$draftId');
  }

  MobileCreationDraft _draftFromResponse(Map<String, dynamic> data) {
    return MobileCreationDraft.fromJson(data['draft'] as Map<String, dynamic>);
  }
}

class CreationConversationCache {
  final _byDraftId = <String, MobileCreationConversationResponse>{};
  final _archivedOverrides = <String, bool>{};
  String? _activeDraftId;
  int _archiveGeneration = 0;

  int get archiveGeneration => _archiveGeneration;

  MobileCreationConversationResponse? readById(String draftId) {
    return _byDraftId[draftId];
  }

  MobileCreationConversationResponse? readActive() {
    final draftId = _activeDraftId;
    return draftId == null ? null : _byDraftId[draftId];
  }

  bool? archivedOverride(String draftId) => _archivedOverrides[draftId];

  void setArchived(String draftId, bool archived) {
    _archiveGeneration++;
    _archivedOverrides[draftId] = archived;
    final current = _byDraftId[draftId];
    final session = current?.session;
    if (current != null && session != null) {
      _byDraftId[draftId] = _withArchived(current, archived);
      _electActive(draftId, status: session.status, archived: archived);
      return;
    }
    if (archived && _activeDraftId == draftId) {
      _activeDraftId = null;
    }
  }

  void clearArchivedOverride(String draftId) {
    _archivedOverrides.remove(draftId);
  }

  void write(MobileCreationConversationResponse response) {
    final session = response.session;
    if (session == null) return;
    final archived = _archivedOverrides[session.draftId] ?? session.archived;
    _byDraftId[session.draftId] = _withArchived(response, archived);
    _electActive(session.draftId, status: session.status, archived: archived);
  }

  void _electActive(
    String draftId, {
    required String status,
    required bool archived,
  }) {
    if (status == 'ACTIVE' && !archived) {
      _activeDraftId = draftId;
    } else if (_activeDraftId == draftId) {
      _activeDraftId = null;
    }
  }

  MobileCreationConversationResponse _withArchived(
    MobileCreationConversationResponse response,
    bool archived,
  ) {
    final session = response.session;
    if (session == null || session.archived == archived) return response;
    return MobileCreationConversationResponse(
      turn: response.turn,
      session: session.copyWith(archived: archived),
    );
  }

  void updateTitle({required String draftId, required String title}) {
    final current = _byDraftId[draftId];
    final session = current?.session;
    if (current == null || session == null) return;
    _byDraftId[draftId] = MobileCreationConversationResponse(
      turn: current.turn,
      session: session.copyWith(title: title),
    );
  }

  void remove(String draftId) {
    _byDraftId.remove(draftId);
    if (_activeDraftId == draftId) {
      _activeDraftId = null;
    }
  }
}

final creationRepositoryProvider = Provider<CreationRepository>((ref) {
  return MobileCreationRepository(apiClient: ref.watch(apiClientProvider));
});

final creationConversationCacheProvider = Provider<CreationConversationCache>((
  ref,
) {
  return CreationConversationCache();
});

class ChatHistoryState {
  const ChatHistoryState({
    required this.sessions,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<MobileChatSession> sessions;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  ChatHistoryState asLoadingMore() => ChatHistoryState(
    sessions: sessions,
    nextCursor: nextCursor,
    loadingMore: true,
  );

  ChatHistoryState asLoadMoreFailed() => ChatHistoryState(
    sessions: sessions,
    nextCursor: nextCursor,
    loadMoreFailed: true,
  );
}

/// One history per query. Requests from an old query, refresh, or signed-out
/// account cannot append to the currently displayed list.
class ChatHistoryController extends AsyncNotifier<ChatHistoryState> {
  ChatHistoryController([this.query = '']);

  final String query;
  int _generation = 0;

  @override
  Future<ChatHistoryState> build() async {
    _generation++;
    ref.onDispose(() => _generation++);
    final repository = ref.watch(creationRepositoryProvider);
    if (query.isNotEmpty) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (!ref.mounted) return const ChatHistoryState(sessions: []);
    }
    final page = await repository.listSessionsPage(query: query);
    return ChatHistoryState(
      sessions: page.sessions,
      nextCursor: page.nextCursor,
    );
  }

  Future<void> loadMore({bool retry = false}) async {
    final current = state.value;
    if (state.isLoading ||
        current == null ||
        current.nextCursor == null ||
        current.loadingMore ||
        (current.loadMoreFailed && !retry)) {
      return;
    }
    final generation = _generation;
    state = AsyncData(current.asLoadingMore());
    try {
      final page = await ref
          .read(creationRepositoryProvider)
          .listSessionsPage(cursor: current.nextCursor, query: query);
      if (!ref.mounted || generation != _generation) return;
      if (page.nextCursor == current.nextCursor) {
        throw StateError('Chat history cursor did not advance.');
      }
      final seen = current.sessions.map((session) => session.draftId).toSet();
      state = AsyncData(
        ChatHistoryState(
          sessions: [
            ...current.sessions,
            for (final session in page.sessions)
              if (seen.add(session.draftId)) session,
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } catch (_) {
      if (!ref.mounted || generation != _generation) return;
      state = AsyncData(current.asLoadMoreFailed());
    }
  }
}

final chatSessionsProvider =
    AsyncNotifierProvider<ChatHistoryController, ChatHistoryState>(
      ChatHistoryController.new,
    );

final chatSearchProvider = AsyncNotifierProvider.autoDispose
    .family<ChatHistoryController, ChatHistoryState, String>(
      ChatHistoryController.new,
    );

final archivedChatSessionsProvider = FutureProvider<List<MobileChatSession>>((
  ref,
) {
  return ref.watch(creationRepositoryProvider).listArchivedSessions();
});

void invalidateChatSessionLists(Object ref) {
  final invalidate = switch (ref) {
    final Ref r => r.invalidate,
    final WidgetRef r => r.invalidate,
    _ => throw ArgumentError.value(ref, 'ref', 'Expected Ref or WidgetRef'),
  };
  invalidate(chatSessionsProvider);
  invalidate(chatSearchProvider);
  invalidate(archivedChatSessionsProvider);
}

/// Refresh both lists even if the initiating widget closes during the request.
final chatArchiveActionsProvider = Provider<ChatArchiveActions>(
  ChatArchiveActions.new,
);

class ChatArchiveActions {
  ChatArchiveActions(this.ref);

  final Ref ref;

  Future<void> setArchived({
    required String draftId,
    required bool archived,
  }) async {
    await ref
        .read(creationRepositoryProvider)
        .setSessionArchived(draftId: draftId, archived: archived);
    if (!ref.mounted) return;
    ref.read(creationConversationCacheProvider).setArchived(draftId, archived);
    invalidateChatSessionLists(ref);
  }
}
