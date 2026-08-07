import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../projects/data/creation_repository.dart';
import '../../projects/data/projects_repository.dart';
import '../data/auth_repository.dart';
import '../domain/auth_models.dart';

final authControllerProvider =
    AsyncNotifierProvider<AuthController, AuthSession?>(AuthController.new);

class AuthController extends AsyncNotifier<AuthSession?> {
  @override
  Future<AuthSession?> build() {
    return ref.read(authRepositoryProvider).restoreSession();
  }

  Future<void> signIn({required String email, required String password}) async {
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
    state = const AsyncLoading();
    state = await AsyncValue.guard(
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
  }

  Future<void> acceptCurrentLegalDocuments() async {
    final current = state.asData?.value;
    if (current == null) return;
    await ref.read(authRepositoryProvider).acceptCurrentLegalDocuments();
    state = AsyncData(
      AuthSession(
        user: current.user.copyWith(legalAcceptanceRequired: false),
        tokens: current.tokens,
      ),
    );
  }

  Future<void> logout() async {
    state = const AsyncLoading();
    await ref.read(authRepositoryProvider).logout();
    // Books and chats are cached across screens so the drawer can open without
    // a blank frame; that cache belongs to the account that just signed out.
    // `asReload` marks the refetch as a dependency change rather than a
    // refresh, so whoever signs in next sees the loading state instead of the
    // previous account's list.
    ref.invalidate(projectsProvider, asReload: true);
    ref.invalidate(chatSessionsProvider, asReload: true);
    ref.invalidate(creationConversationCacheProvider);
    state = const AsyncData(null);
  }
}
