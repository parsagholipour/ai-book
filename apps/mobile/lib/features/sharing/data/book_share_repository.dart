import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_client.dart';
import '../domain/book_remix.dart';
import '../domain/book_share_models.dart';

/// A book's public link on the server — `/api/mobile/projects/:id/share` —
/// and the format a "Make a book like this" link hands to a new chat.
abstract interface class BookShareRepository {
  Future<BookShareSnapshot> loadShare(String projectId);

  /// Creates the share, changes it in place, or shares again after a stop.
  /// Throws the server's refusal as an `ApiException`; a changed note makes
  /// this wait on a moderation model, so it can take several seconds.
  Future<BookShareSnapshot> saveShare(
    String projectId,
    BookShareRequest request,
  );

  /// Stops sharing: the link stops working for everyone who has it.
  Future<BookShareSnapshot> stopSharing(String projectId);

  /// The shared book's format. `SHARE_NOT_FOUND` (404) and
  /// `REMIX_NOT_AVAILABLE` (410) mean there is nothing to start from.
  Future<BookRemix> loadRemix(String slug);
}

class MobileBookShareRepository implements BookShareRepository {
  const MobileBookShareRepository({required this.apiClient});

  final ApiClient apiClient;

  String _path(String projectId) => '/api/mobile/projects/$projectId/share';

  @override
  Future<BookShareSnapshot> loadShare(String projectId) async {
    return BookShareSnapshot.fromJson(await apiClient.getMap(_path(projectId)));
  }

  @override
  Future<BookShareSnapshot> saveShare(
    String projectId,
    BookShareRequest request,
  ) async {
    final response = await apiClient.putJson(
      _path(projectId),
      data: request.toJson(),
      // A changed note is read by a model before the answer comes back.
      receiveTimeout: llmReceiveTimeout,
    );
    return BookShareSnapshot.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<BookShareSnapshot> stopSharing(String projectId) async {
    final response = await apiClient.deleteJson(_path(projectId));
    return BookShareSnapshot.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<BookRemix> loadRemix(String slug) async {
    final data = await apiClient.getMap(
      '/api/mobile/shares/${Uri.encodeComponent(slug)}/remix',
    );
    return BookRemix.fromJson(slug, data);
  }
}

final bookShareRepositoryProvider = Provider<BookShareRepository>((ref) {
  return MobileBookShareRepository(apiClient: ref.watch(apiClientProvider));
});

/// One book's sharing, kept current by the sheet's own saves so a save never
/// has to be followed by a second read.
class BookShareController extends AsyncNotifier<BookShareSnapshot> {
  BookShareController(this.projectId);

  final String projectId;

  BookShareRepository get _repository => ref.read(bookShareRepositoryProvider);

  @override
  Future<BookShareSnapshot> build() {
    return ref.watch(bookShareRepositoryProvider).loadShare(projectId);
  }

  /// Kept alive until the answer lands, so a sheet closed mid-save still
  /// leaves the book's state current.
  Future<BookShareSnapshot> save(BookShareRequest request) async {
    final link = ref.keepAlive();
    try {
      final saved = await _repository.saveShare(projectId, request);
      state = AsyncData(saved);
      return saved;
    } finally {
      link.close();
    }
  }

  Future<void> stop() async {
    final link = ref.keepAlive();
    try {
      state = AsyncData(await _repository.stopSharing(projectId));
    } finally {
      link.close();
    }
  }
}

/// A failed read is not retried behind the author's back: the sheet says so
/// and offers Try again.
final bookShareProvider = AsyncNotifierProvider.autoDispose
    .family<BookShareController, BookShareSnapshot, String>(
      BookShareController.new,
      retry: (_, _) => null,
    );

/// Hands a share link to the system share sheet.
typedef ShareLinkSender = Future<void> Function(String url, {String? subject});

/// A provider rather than a direct `SharePlus` call so a test can see what
/// would have been shared without a platform channel behind it.
final shareLinkSenderProvider = Provider<ShareLinkSender>((ref) {
  return (url, {subject}) async {
    await SharePlus.instance.share(
      ShareParams(uri: Uri.parse(url), subject: subject, title: subject),
    );
  };
});
