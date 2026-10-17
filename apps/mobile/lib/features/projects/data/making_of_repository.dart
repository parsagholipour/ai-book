import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/making_of_models.dart';

/// "Behind the book" for a finished book — `/api/mobile/projects/:id/making-of`.
abstract interface class MakingOfRepository {
  Future<MobileMakingOf> getMakingOf(String projectId);
}

class HttpMakingOfRepository implements MakingOfRepository {
  HttpMakingOfRepository(this.apiClient);

  final ApiClient apiClient;

  @override
  Future<MobileMakingOf> getMakingOf(String projectId) async {
    final data = await apiClient.getMap(
      '/api/mobile/projects/$projectId/making-of',
    );
    return MobileMakingOf.fromJson(data);
  }
}

final makingOfRepositoryProvider = Provider<MakingOfRepository>((ref) {
  return HttpMakingOfRepository(ref.watch(apiClientProvider));
});

/// Read once per visit to the card, and not retried behind the reader's back:
/// the section draws nothing it cannot back, so a failure reads as a book with
/// nothing to show, never as an error.
final makingOfProvider = FutureProvider.autoDispose
    .family<MobileMakingOf, String>(
      (ref, projectId) =>
          ref.watch(makingOfRepositoryProvider).getMakingOf(projectId),
      retry: (_, _) => null,
    );
