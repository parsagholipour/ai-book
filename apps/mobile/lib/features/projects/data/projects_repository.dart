import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_client.dart';
import '../domain/project_models.dart';

abstract interface class ProjectsRepository {
  Future<List<MobileProjectSummary>> listProjects();

  Future<MobileProjectDetail> createProject(MobileProjectCreateRequest request);

  Future<MobileProjectDetail> getProject(String id);

  Future<MobilePlanOperation> generatePlan(String projectId);

  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
  });

  Future<MobilePlanOperation> approvePlan(String planId);

  Future<MobileProjectStatus> getProjectStatus(String id);

  Stream<MobileProjectStatus> watchProjectStatus(String id);

  Future<MobileProjectChat> getProjectChat(String id);

  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
  });

  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
  });

  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  });

  Future<MobileProjectRecovery> resumeProject(String id);

  Future<ProjectDeletionReceipt> deleteProject(String id);

  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  });

  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  });

  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  });

  Future<void> shareExport({
    required String projectId,
    required MobileExportAvailability export,
  });

  Future<Map<String, String>> assetHeaders();
}

class MobileProjectsRepository implements ProjectsRepository {
  const MobileProjectsRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    final response = await apiClient.getJson('/api/mobile/projects');
    final data = response.data as Map<String, dynamic>;
    final projects = data['projects'] as List<dynamic>;
    return projects
        .map(
          (project) =>
              MobileProjectSummary.fromJson(project as Map<String, dynamic>),
        )
        .toList();
  }

  @override
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects',
      data: request.toJson(),
    );
    final data = response.data as Map<String, dynamic>;
    return MobileProjectDetail.fromJson(
      data['project'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    final response = await apiClient.getJson('/api/mobile/projects/$id');
    final data = response.data as Map<String, dynamic>;
    return MobileProjectDetail.fromJson(
      data['project'] as Map<String, dynamic>,
    );
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/plan',
      data: const <String, dynamic>{},
    );
    return MobilePlanOperation.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/plans/$planId/revise',
      data: {'message': message},
    );
    return MobilePlanOperation.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobilePlanOperation> approvePlan(String planId) async {
    final response = await apiClient.postJson(
      '/api/mobile/plans/$planId/approve',
    );
    return MobilePlanOperation.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    final response = await apiClient.getJson('/api/mobile/projects/$id/status');
    final data = response.data as Map<String, dynamic>;
    return MobileProjectStatus.fromJson(data['status'] as Map<String, dynamic>);
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    await for (final event in apiClient.getServerSentEvents(
      '/api/mobile/projects/$id/status/events',
    )) {
      if (event.event != 'status') {
        continue;
      }
      final decoded = jsonDecode(event.data) as Map<String, dynamic>;
      final status = decoded['status'] is Map<String, dynamic>
          ? decoded['status'] as Map<String, dynamic>
          : decoded;
      yield MobileProjectStatus.fromJson(status);
    }
  }

  @override
  Future<MobileProjectChat> getProjectChat(String id) async {
    final response = await apiClient.getJson('/api/mobile/projects/$id/chat');
    return MobileProjectChat.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/chat/messages',
      data: {'message': message},
    );
    return MobileProjectChatSendResult.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/chat/messages',
      data: {'message': message, 'editMessageId': messageId},
    );
    return MobileProjectChatSendResult.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/chat/branches',
      data: {'messageId': messageId, 'direction': direction},
    );
    return MobileProjectChat.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<MobileProjectRecovery> resumeProject(String id) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$id/resume',
    );
    return MobileProjectRecovery.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<ProjectDeletionReceipt> deleteProject(String id) async {
    final response = await apiClient.deleteJson('/api/mobile/projects/$id');
    return ProjectDeletionReceipt.fromJson(
      response.data as Map<String, dynamic>,
    );
  }

  @override
  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/reports',
      data: _reportPayload(reason: reason, comment: comment),
    );
    final data = response.data as Map<String, dynamic>;
    return ModerationReportReceipt.fromJson(
      data['report'] as Map<String, dynamic>,
    );
  }

  @override
  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  }) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$projectId/assets/$assetId/reports',
      data: _reportPayload(reason: reason, comment: comment),
    );
    final data = response.data as Map<String, dynamic>;
    return ModerationReportReceipt.fromJson(
      data['report'] as Map<String, dynamic>,
    );
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    final directory = await getApplicationDocumentsDirectory();
    final safeProjectId = projectId.replaceAll(
      RegExp(r'[^A-Za-z0-9._-]+'),
      '-',
    );
    final exportDirectory = Directory(
      '${directory.path}/tomeza_exports/$safeProjectId',
    );
    if (!await exportDirectory.exists()) {
      await exportDirectory.create(recursive: true);
    }
    final filename = _safeLocalFilename(export.filename, export.format);
    final path = '${exportDirectory.path}/$filename';
    await apiClient.downloadFile(export.downloadUrl, path);
    return ProjectExportFile(
      format: export.format,
      filename: filename,
      path: path,
    );
  }

  @override
  Future<void> shareExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    final file = await downloadExport(projectId: projectId, export: export);
    await SharePlus.instance.share(
      ShareParams(
        title: file.filename,
        subject: file.filename,
        files: [XFile(file.path, mimeType: export.contentType)],
        fileNameOverrides: [file.filename],
      ),
    );
  }

  @override
  Future<Map<String, String>> assetHeaders() {
    return apiClient.authHeaders();
  }
}

final projectsRepositoryProvider = Provider<ProjectsRepository>((ref) {
  return MobileProjectsRepository(apiClient: ref.watch(apiClientProvider));
});

final projectsProvider = FutureProvider.autoDispose<List<MobileProjectSummary>>(
  (ref) {
    return ref.watch(projectsRepositoryProvider).listProjects();
  },
);

final projectDetailProvider = FutureProvider.autoDispose
    .family<MobileProjectDetail, String>((ref, id) {
      return ref.watch(projectsRepositoryProvider).getProject(id);
    });

final projectStatusProvider = StreamProvider.autoDispose
    .family<MobileProjectStatus, String>((ref, id) {
      return _watchProjectStatus(ref.watch(projectsRepositoryProvider), id);
    });

final projectChatProvider = FutureProvider.autoDispose
    .family<MobileProjectChat, String>((ref, id) {
      return ref.watch(projectsRepositoryProvider).getProjectChat(id);
    });

final projectAssetHeadersProvider =
    FutureProvider.autoDispose<Map<String, String>>((ref) {
      return ref.watch(projectsRepositoryProvider).assetHeaders();
    });

String _safeLocalFilename(String filename, String format) {
  final fallback = 'book.$format';
  final cleaned = filename
      .replaceAll(RegExp(r'[/\\]+'), '-')
      .replaceAll(RegExp(r'[^A-Za-z0-9._ -]+'), '')
      .trim();
  return cleaned.isEmpty ? fallback : cleaned;
}

Map<String, dynamic> _reportPayload({required String reason, String? comment}) {
  return {
    'reason': reason,
    if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim(),
  };
}

Stream<MobileProjectStatus> _watchProjectStatus(
  ProjectsRepository repository,
  String id,
) async* {
  try {
    var emittedStatus = false;
    await for (final status in repository.watchProjectStatus(id)) {
      emittedStatus = true;
      yield status;
      if (!_isLiveProjectStatus(status)) {
        return;
      }
    }
    if (emittedStatus) {
      return;
    }
  } catch (_) {
    // Older API builds, local proxies, or transient stream failures fall back
    // to short polling so the progress UI remains live enough to trust.
  }

  while (true) {
    final status = await repository.getProjectStatus(id);
    yield status;
    if (!_isLiveProjectStatus(status)) {
      return;
    }
    await Future<void>.delayed(const Duration(seconds: 3));
  }
}

bool _isLiveProjectStatus(MobileProjectStatus status) {
  return status.status == 'planning' ||
      status.status == 'generating' ||
      status.status == 'editing';
}
