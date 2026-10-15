import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/author_profile.dart';
import '../domain/book_matter.dart';

/// The author profile and one book's matter on the server — see
/// `.scratch/book-matter/spec.md` § API.
///
/// Every write is partial: only the keys an update carries are sent, and a
/// null clears its field. Text is screened like the Studio's settings, so a
/// write can be refused with a 422 `CONTENT_RESTRICTED` naming its `fields`
/// (read it with [MatterSaveError.from]).
abstract interface class BookMatterRepository {
  /// The profile, or its defaults when the author has never saved one.
  Future<AuthorProfile> getAuthorProfile();

  Future<AuthorProfile> updateAuthorProfile(AuthorProfileUpdate update);

  Future<BookMatter> getBookMatter(String projectId);

  /// Throws `PROJECT_BUSY` while an edit or job owns a settled book,
  /// `SET_IN_STUDIO` for an author name or dedication on a Studio book, and
  /// `INVALID_ISBN` for an ISBN whose check digit fails.
  Future<BookMatterSaved> updateBookMatter(
    String projectId,
    BookMatterUpdate update,
  );

  /// Takes the free tier's "Made with Tomeza" line off a finished book's
  /// files: free, and for subscribers only. Throws 403
  /// `SUBSCRIPTION_REQUIRED` for a free account, and 409 `PROJECT_BUSY` while
  /// the book is unfinished or busy — its message says which.
  Future<BookMatterCreditRemoval> removeTomezaCredit(String projectId);
}

class MobileBookMatterRepository implements BookMatterRepository {
  MobileBookMatterRepository({required this.apiClient});

  final ApiClient apiClient;

  static const _profilePath = '/api/mobile/author-profile';

  String _matterPath(String projectId) =>
      '/api/mobile/projects/$projectId/book-matter';

  @override
  Future<AuthorProfile> getAuthorProfile() async {
    final data = await apiClient.getMap(_profilePath);
    return AuthorProfile.fromJson(data['profile'] as Map<String, dynamic>);
  }

  @override
  Future<AuthorProfile> updateAuthorProfile(AuthorProfileUpdate update) async {
    final response = await apiClient.putJson(
      _profilePath,
      data: update.toJson(),
    );
    final data = response.data as Map<String, dynamic>;
    return AuthorProfile.fromJson(data['profile'] as Map<String, dynamic>);
  }

  @override
  Future<BookMatter> getBookMatter(String projectId) async {
    final data = await apiClient.getMap(_matterPath(projectId));
    return BookMatter.fromJson(data['bookMatter'] as Map<String, dynamic>);
  }

  @override
  Future<BookMatterSaved> updateBookMatter(
    String projectId,
    BookMatterUpdate update,
  ) async {
    final response = await apiClient.patchJson(
      _matterPath(projectId),
      data: update.toJson(),
    );
    return BookMatterSaved.fromJson(response.data as Map<String, dynamic>);
  }

  @override
  Future<BookMatterCreditRemoval> removeTomezaCredit(String projectId) async {
    final data = await apiClient.postMap(
      '${_matterPath(projectId)}/remove-credit',
    );
    return BookMatterCreditRemoval.fromJson(data);
  }
}

final bookMatterRepositoryProvider = Provider<BookMatterRepository>((ref) {
  return MobileBookMatterRepository(apiClient: ref.watch(apiClientProvider));
});

/// The author profile, kept current by every save made through it — so the
/// book page's setup card hears the answer without fetching it again.
class AuthorProfileController extends AsyncNotifier<AuthorProfile> {
  @override
  Future<AuthorProfile> build() {
    return ref.watch(bookMatterRepositoryProvider).getAuthorProfile();
  }

  /// Saves [update] and shows the server's answer to everyone watching.
  ///
  /// The profile is held while the write is out: the screen that asked may
  /// go back meanwhile, and an unwatched profile disposed under the save
  /// would throw on its answer — reporting a write the server took as failed.
  Future<AuthorProfile> save(AuthorProfileUpdate update) async {
    final keepAlive = ref.keepAlive();
    try {
      final saved = await ref
          .read(bookMatterRepositoryProvider)
          .updateAuthorProfile(update);
      state = AsyncData(saved);
      return saved;
    } finally {
      keepAlive.close();
    }
  }

  /// Shows a profile saved somewhere else (the setup card's own two-step
  /// save), without another request.
  void saved(AuthorProfile profile) => state = AsyncData(profile);

  /// Answers the setup prompt with a Not now. The card goes at once; the
  /// request follows, and a failed one only means the server asks again
  /// another day.
  Future<void> dismissSetupPrompt() async {
    final current = state.value;
    if (current != null) {
      state = AsyncData(current.copyWith(setupPromptSeen: true));
    }
    try {
      final saved = await ref
          .read(bookMatterRepositoryProvider)
          .updateAuthorProfile(const AuthorProfileUpdate.promptSeen());
      state = AsyncData(saved);
    } catch (_) {
      // Leave the card answered for this visit; the profile still says unseen
      // on the server, so it comes back on a later one.
    }
  }
}

/// A failed read is not retried behind the reader's back: the profile screen
/// says so with a Try again, and the book page shows no setup card at all.
final authorProfileProvider =
    AsyncNotifierProvider.autoDispose<AuthorProfileController, AuthorProfile>(
      AuthorProfileController.new,
      retry: (_, _) => null,
    );

/// One book's matter, read fresh each time its sheet opens.
final bookMatterProvider = FutureProvider.autoDispose
    .family<BookMatter, String>(
      (ref, projectId) =>
          ref.watch(bookMatterRepositoryProvider).getBookMatter(projectId),
      retry: (_, _) => null,
    );

/// The matter one book's last save answered with, for what stays on the book
/// page across that save: the setup card holds a byline and dedication it read
/// before the Title & credits sheet changed them. Null until a save is heard.
///
/// A change, not a read: nothing is cached here, so the sheet still reads
/// [bookMatterProvider] fresh each time it opens.
class SavedBookMatter extends Notifier<BookMatter?> {
  SavedBookMatter(this.projectId);

  final String projectId;

  @override
  BookMatter? build() => null;

  void saved(BookMatter matter) => state = matter;
}

final savedBookMatterProvider = NotifierProvider.autoDispose
    .family<SavedBookMatter, BookMatter?, String>(SavedBookMatter.new);

/// Tells whatever on the page is showing [projectId]'s matter what a save left
/// it as. With nothing listening there is no one to tell, and the next card
/// reads the server.
void announceBookMatterSaved(
  ProviderContainer container,
  String projectId,
  BookMatter matter,
) {
  final provider = savedBookMatterProvider(projectId);
  if (container.exists(provider)) {
    container.read(provider.notifier).saved(matter);
  }
}
