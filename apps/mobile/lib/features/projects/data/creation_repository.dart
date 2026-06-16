import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/creation_models.dart';

abstract interface class CreationRepository {
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

  Future<MobileCreationConversationResponse> startConversation();

  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  });

  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  });
}

class MobileCreationRepository implements CreationRepository {
  const MobileCreationRepository({required this.apiClient});

  final ApiClient apiClient;

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
  Future<MobileCreationConversationResponse> startConversation() async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions',
      data: const <String, dynamic>{},
    );
    return MobileCreationConversationResponse.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/creation-sessions/$draftId/messages',
      data: <String, dynamic>{
        'message': message,
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

  MobileCreationDraft _draftFromResponse(Map<String, dynamic> data) {
    return MobileCreationDraft.fromJson(data['draft'] as Map<String, dynamic>);
  }
}

final creationRepositoryProvider = Provider<CreationRepository>((ref) {
  return MobileCreationRepository(apiClient: ref.watch(apiClientProvider));
});
