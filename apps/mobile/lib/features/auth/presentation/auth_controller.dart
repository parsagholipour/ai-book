import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../notifications/data/push_device_repository.dart';
import '../../projects/data/creation_repository.dart';
import '../../projects/data/offline_library_store.dart';
import '../../projects/data/project_snapshot_cache.dart';
import '../../projects/data/projects_repository.dart';
import '../data/auth_repository.dart';
import '../domain/auth_models.dart';
import '../domain/legal_gate.dart';
import 'verify_email_location.dart';

final authControllerProvider =
    AsyncNotifierProvider<AuthController, AuthSession?>(AuthController.new);

/// Raised when the session ended without the reader signing out, so the
/// sign-in screen can say why it is there. Taken once by the screen that
/// shows it, and not reactive: nothing redraws when it is raised, because the
/// sign-out it explains is what moves the reader to that screen.
final signedOutNoticeProvider = Provider<SignedOutNotice>(
  (ref) => SignedOutNotice(),
);

class SignedOutNotice {
  bool _pending = false;

  void raise() => _pending = true;

  /// Whether there is a notice to show; asking clears it.
  bool take() {
    final pending = _pending;
    _pending = false;
    return pending;
  }
}

class AuthController extends AsyncNotifier<AuthSession?> {
  /// How long an offline session waits before asking the server again, one
  /// step per attempt and the last one repeated. A resume asks at once.
  static const offlineRevalidationDelays = [
    Duration(seconds: 5),
    Duration(seconds: 10),
    Duration(seconds: 20),
    Duration(seconds: 40),
    Duration(seconds: 60),
  ];

  Timer? _revalidationTimer;
  AppLifecycleListener? _resumeListener;
  int _revalidationAttempt = 0;
  bool _revalidating = false;

  @override
  Future<AuthSession?> build() async {
    ref.onDispose(_stopRevalidating);
    final session = await ref.read(authRepositoryProvider).restoreSession();
    // Opened from the phone alone (`MobileAuthRepository._offlineSession`):
    // the reader is in, and the server is asked again until it answers.
    if (session != null && session.offline) _scheduleRevalidation();
    return session;
  }

  /// Asks the server about an offline session, once.
  ///
  /// A confirmed session replaces the offline one; a refused one (the restore
  /// has already cleared the tokens) signs the reader out exactly as a session
  /// lost on screen does; anything else — still no network, a server error —
  /// waits for the next step. Whatever replaced the offline session in the
  /// meantime (a sign-out, a session loss) wins: this changes nothing then.
  Future<void> _revalidate() async {
    final offline = state.asData?.value;
    if (offline == null || !offline.offline) {
      _stopRevalidating();
      return;
    }
    if (_revalidating) return;
    _revalidating = true;
    AuthSession? restored;
    var failed = false;
    try {
      restored = await ref.read(authRepositoryProvider).restoreSession();
    } catch (_) {
      failed = true;
    } finally {
      _revalidating = false;
    }
    if (!identical(state.asData?.value, offline)) return;
    if (failed || (restored?.offline ?? false)) {
      _scheduleRevalidation();
      return;
    }
    _stopRevalidating();
    if (restored == null) {
      sessionLost();
      return;
    }
    state = AsyncData(restored);
  }

  void _scheduleRevalidation({Duration? after}) {
    _revalidationTimer?.cancel();
    final delays = offlineRevalidationDelays;
    final delay =
        after ?? delays[math.min(_revalidationAttempt, delays.length - 1)];
    _revalidationAttempt += 1;
    _revalidationTimer = Timer(delay, () => unawaited(_revalidate()));
    _resumeListener ??= _listenForResume();
  }

  AppLifecycleListener? _listenForResume() {
    try {
      return AppLifecycleListener(
        onResume: () => _scheduleRevalidation(after: Duration.zero),
      );
    } catch (_) {
      // No widgets binding (a bare container in a unit test): the timer alone.
      return null;
    }
  }

  void _stopRevalidating() {
    _revalidationTimer?.cancel();
    _revalidationTimer = null;
    _resumeListener?.dispose();
    _resumeListener = null;
    _revalidationAttempt = 0;
  }

  /// The verify screen confirmed the code: the session on screen now says so.
  void markEmailVerified() {
    final current = state.asData?.value;
    if (current == null || current.user.emailVerified) return;
    state = AsyncData(
      AuthSession(
        user: current.user.copyWith(emailVerified: true),
        tokens: current.tokens,
        offline: current.offline,
      ),
    );
  }

  Future<void> signIn({required String email, required String password}) async {
    _stopRevalidating();
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref
          .read(authRepositoryProvider)
          .signIn(email: email, password: password),
    );
  }

  Future<void> signUp({
    required String email,
    required String password,
    String? displayName,
    required bool termsAccepted,
    required bool ageGuardianAttested,
  }) async {
    _stopRevalidating();
    state = const AsyncLoading();
    final result = await AsyncValue.guard(
      () => ref
          .read(authRepositoryProvider)
          .signUp(
            email: email,
            password: password,
            displayName: displayName,
            termsAccepted: termsAccepted,
            ageGuardianAttested: ageGuardianAttested,
          ),
    );
    // Before the session lands: that is what moves the router, and its
    // landing reads this. The server has already mailed the first code.
    if (result.asData?.value.user.emailVerified == false) {
      ref.read(verifyEmailAfterSignUpProvider).remember();
    }
    state = result;
  }

  /// Installs a session minted outside the sign-in/sign-up calls — the
  /// password reset flow signs the reader in with the server's response. The
  /// screen owns its own loading and error surface, so nothing here emits
  /// loading or error states for other listeners to re-announce.
  void adoptSession(AuthSession session) {
    _stopRevalidating();
    state = AsyncData(session);
  }

  Future<void> acceptCurrentLegalDocuments() async {
    final current = state.asData?.value;
    if (current == null) return;
    await ref.read(authRepositoryProvider).acceptCurrentLegalDocuments();
    ref.read(legalGateDismissedProvider.notifier).reset();
    state = AsyncData(
      AuthSession(
        user: current.user.copyWith(legalAcceptanceRequired: false),
        tokens: current.tokens,
      ),
    );
  }

  /// Returns once this device is signed out. The server is told without
  /// waiting for it (see `MobileAuthRepository.logout`).
  Future<void> logout() async {
    _stopRevalidating();
    state = const AsyncLoading();
    await ref.read(authRepositoryProvider).logout();
    _forgetAccount();
    state = const AsyncData(null);
  }

  /// The server stopped honouring this install's session and the API client
  /// has already cleared its tokens (`ApiClient.onSessionLost`): the same
  /// sign-out as [logout], with nothing left to revoke, and a notice on the
  /// sign-in screen because the reader did not ask for it.
  ///
  /// Only a session on screen can be lost. A restore, a sign-in or a logout
  /// in progress has none (`asData` is null while loading), and settles the
  /// state itself; a call then, or a second call for the same loss, does
  /// nothing.
  void sessionLost() {
    if (state.asData?.value == null) return;
    _stopRevalidating();
    _forgetAccount();
    ref.read(signedOutNoticeProvider).raise();
    state = const AsyncData(null);
  }

  /// Everything on this install that belongs to the account that just left.
  void _forgetAccount() {
    // A "Not now" on the updated-terms gate belongs to the account that chose
    // it; whoever signs in next starts at the gate if they still owe assent.
    ref.read(legalGateDismissedProvider.notifier).reset();
    // So do the verify-email prompts.
    ref.read(verifyEmailAfterSignUpProvider).clear();
    ref.invalidate(verifyEmailBannerDismissedProvider);
    // Books and chats are cached across screens so the drawer can open without
    // a blank frame; that cache belongs to the account that just signed out.
    // `asReload` marks the refetch as a dependency change rather than a
    // refresh, so whoever signs in next sees the loading state instead of the
    // previous account's list.
    ref.invalidate(projectsProvider, asReload: true);
    ref.invalidate(chatSessionsProvider, asReload: true);
    ref.invalidate(chatSearchProvider, asReload: true);
    ref.invalidate(archivedChatSessionsProvider, asReload: true);
    ref.invalidate(creationConversationCacheProvider);
    ref.invalidate(projectSnapshotCacheProvider);
    // So does the library kept on the phone for being offline: an offline
    // start opens the account the phone holds, and these files must be that
    // account's. Cleared, not left for the next sign-in to overwrite, because
    // nothing may show one account's books to another even for a frame.
    unawaited(ref.read(offlineLibraryStoreProvider).clear());
    // Its book notifications come down and this install's FCM token goes, so
    // a server that never heard about the sign-out has nowhere to send.
    unawaited(ref.read(pushRegistrarProvider)?.signOut());
  }
}
