import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/creation_models.dart';

abstract interface class CreationRepository {
  Future<List<MobileChatSession>> listSessions();

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
  });

  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  });

  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
  });

  Future<void> deleteAttachment({
    required String draftId,
    required String attachmentId,
  });

  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  });

  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  });

  Future<void> renameSession({required String draftId, required String title});

  Future<void> deleteSession(String draftId);
}

class MobileCreationRepository implements CreationRepository {
  const MobileCreationRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<MobileChatSession>> listSessions() async {
    final response = await apiClient.getJson('/api/mobile/creation-sessions');
    final data = response.data as Map<String, dynamic>;
    final list = data['sessions'] as List<dynamic>;
    return list
        .cast<Map<String, dynamic>>()
        .map(MobileChatSession.fromJson)
        .toList(growable: false);
  }

  @override
  Future<MobileCreationDraft?> getActiveDraft() async {
    final response = await apiClient.getJson(
      '/api/mobile/creation-drafts/active',
    );
    final data = response.data as Map<String, dynamic>;
    final draft = data['draft'];
    return draft == null
        ? null
        : MobileCreationDraft.fromJson(draft as Map<String, dynamic>);
  }

  @override
  Future<MobileCreationDraft> createDraft(
    MobileCreationDraftPayload payload,
  ) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-drafts',
      data: payload.toJson(),
    );
    return _draftFromResponse(response.data as Map<String, dynamic>);
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
    final response = await apiClient.postJson(
      '/api/mobile/book-advisor',
      data: payload.toJson(),
    );
    final data = response.data as Map<String, dynamic>;
    return MobileBookAdvisorResponse.fromJson(
      data['advisor'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-drafts/$id/create-project',
      data: const <String, dynamic>{},
    );
    return MobileCreationFinalizeResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    final response = await apiClient.getJson(
      '/api/mobile/creation-sessions/active',
    );
    return MobileCreationConversationResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    final response = await apiClient.getJson(
      '/api/mobile/creation-sessions/$draftId',
    );
    return MobileCreationConversationResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions',
      data: <String, dynamic>{
        'message': ?message,
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
      },
    );
    return MobileCreationConversationResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions/$draftId/messages',
      data: <String, dynamic>{
        'message': message,
        if (attachmentIds != null && attachmentIds.isNotEmpty)
          'attachmentIds': attachmentIds,
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
      },
    );
    return MobileCreationConversationResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
  }) async {
    final response = await apiClient.postBytes(
      '/api/mobile/creation-sessions/$draftId/attachments',
      bytes: bytes,
      queryParameters: {
        'filename': filename,
        if (mimeType != null && mimeType.isNotEmpty) 'mimeType': mimeType,
      },
      onSendProgress: onProgress,
    );
    final data = response.data as Map<String, dynamic>;
    return MobileCreationAttachment.fromJson(
      data['attachment'] as Map<String, dynamic>,
    );
  }

  @override
  Future<void> deleteAttachment({
    required String draftId,
    required String attachmentId,
  }) async {
    await apiClient.deleteJson(
      '/api/mobile/creation-sessions/$draftId/attachments/$attachmentId',
    );
  }

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions/$draftId/build',
      data: <String, dynamic>{
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        'language': ?language,
      },
    );
    return MobileCreationFinalizeResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions/$draftId/preflight',
      data: <String, dynamic>{
        'presets': ?presets?.toJson(),
        'sourceNotes': ?sourceNotes,
        'optionalDetails': ?optionalDetails?.toJson(),
        'language': ?language,
      },
    );
    return MobileCreationBuildPreflight.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<void> renameSession({
    required String draftId,
    required String title,
  }) async {
    await apiClient.patchJson(
      '/api/mobile/creation-sessions/$draftId/title',
      data: <String, dynamic>{'title': title},
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
  String? _activeDraftId;

  MobileCreationConversationResponse? readById(String draftId) {
    return _byDraftId[draftId];
  }

  MobileCreationConversationResponse? readActive() {
    final draftId = _activeDraftId;
    return draftId == null ? null : _byDraftId[draftId];
  }

  void write(MobileCreationConversationResponse response) {
    final session = response.session;
    if (session == null) return;
    _byDraftId[session.draftId] = response;
    if (session.status == 'ACTIVE') {
      _activeDraftId = session.draftId;
    }
  }

  void updateTitle({required String draftId, required String title}) {
    final current = _byDraftId[draftId];
    final session = current?.session;
    if (current == null || session == null) return;
    _byDraftId[draftId] = MobileCreationConversationResponse(
      turn: current.turn,
      session: MobileCreationSession(
        draftId: session.draftId,
        title: title,
        status: session.status,
        messages: session.messages,
        createdProjectId: session.createdProjectId,
        activeProjectId: session.activeProjectId,
        outputs: session.outputs,
        attachments: session.attachments,
        updatedAt: session.updatedAt,
      ),
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

final chatSessionsProvider = FutureProvider<List<MobileChatSession>>((ref) {
  return ref.watch(creationRepositoryProvider).listSessions();
});
