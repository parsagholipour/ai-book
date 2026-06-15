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

  Future<MobileProjectRecovery> resumeProject(String id);

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
  Future<MobileProjectRecovery> resumeProject(String id) async {
    final response = await apiClient.postJson(
      '/api/mobile/projects/$id/resume',
    );
    return MobileProjectRecovery.fromJson(
      response.data as Map<String, dynamic>,
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

final projectStatusProvider = FutureProvider.autoDispose
    .family<MobileProjectStatus, String>((ref, id) {
      return ref.watch(projectsRepositoryProvider).getProjectStatus(id);
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
