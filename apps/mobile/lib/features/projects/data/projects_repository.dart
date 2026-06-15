import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/project_models.dart';

abstract interface class ProjectsRepository {
  Future<List<MobileProjectSummary>> listProjects();
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
}

final projectsRepositoryProvider = Provider<ProjectsRepository>((ref) {
  return MobileProjectsRepository(apiClient: ref.watch(apiClientProvider));
});

final projectsProvider = FutureProvider.autoDispose<List<MobileProjectSummary>>(
  (ref) {
    return ref.watch(projectsRepositoryProvider).listProjects();
  },
);
