import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/account/presentation/account_screen.dart';
import '../../features/auth/presentation/auth_controller.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/auth/presentation/legal_acceptance_screen.dart';
import '../../features/projects/presentation/book_edit_screen.dart';
import '../../features/projects/presentation/book_screen.dart';
import '../../features/projects/presentation/creation_chat_screen.dart';
import '../../features/projects/presentation/edit_changes_screen.dart';
import '../../features/projects/presentation/import_book_screen.dart';
import '../../features/projects/presentation/project_chat_screen.dart';
import '../../features/audiobook/presentation/audiobook_screen.dart';
import '../../features/reader/presentation/book_reader_screen.dart';
import '../../shared/api/api_error.dart';
import '../../shared/ui/feedback/app_feedback.dart';
import '../../shared/ui/motion.dart';
import 'exit_confirmation.dart';

/// Screen transition used for every route.
///
/// A short fade paired with a small upward slide reads as "this screen came
/// from the one you were on", without the latency of a full slide-across. The
/// slide is dropped when the platform asks for reduced motion.
CustomTransitionPage<void> _appPage(GoRouterState state, Widget child) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionDuration: AppMotion.medium,
    reverseTransitionDuration: AppMotion.fast,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final fade = CurvedAnimation(parent: animation, curve: AppMotion.enter);
      if (AppMotion.reducedMotion(context)) {
        return FadeTransition(opacity: fade, child: child);
      }
      return FadeTransition(
        opacity: fade,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.02),
            end: Offset.zero,
          ).animate(fade),
          child: child,
        ),
      );
    },
  );
}

/// Reads what a caller asked the book chat to do on open.
///
/// A bare string stays supported as a composer prefill.
ProjectChatLaunch? _chatLaunch(Object? extra) {
  if (extra is ProjectChatLaunch) return extra;
  if (extra is String) return ProjectChatLaunch(draft: extra);
  return null;
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final authRefresh = ValueNotifier(0);
  ref.listen(authControllerProvider, (_, _) {
    authRefresh.value += 1;
  });
  ref.onDispose(authRefresh.dispose);

  final router = GoRouter(
    initialLocation: '/home',
    refreshListenable: authRefresh,
    redirect: (context, state) {
      final authState = ref.read(authControllerProvider);
      final path = state.uri.path;
      final isAuthRoute = path.startsWith('/auth');
      final isSplash = path == '/splash';
      final isLegalAcceptance = path == '/legal/acceptance';
      final currentSession = authState.asData?.value;
      final hasSession = currentSession != null;

      if (authState.isLoading && currentSession == null) {
        return isAuthRoute || isSplash ? null : '/splash';
      }

      if (authState.hasError && currentSession == null) {
        return isAuthRoute || isSplash ? null : '/splash';
      }

      if (!hasSession) {
        return isAuthRoute ? null : '/auth/sign-in';
      }

      if (currentSession.user.legalAcceptanceRequired) {
        return isLegalAcceptance || path == '/account'
            ? null
            : '/legal/acceptance';
      }

      if (isAuthRoute || isSplash || isLegalAcceptance) {
        return '/home';
      }

      return null;
    },
    routes: [
      GoRoute(
        path: '/splash',
        pageBuilder: (context, state) => _appPage(state, const SplashScreen()),
      ),
      GoRoute(
        path: '/auth/sign-in',
        pageBuilder: (context, state) =>
            _appPage(state, const AuthScreen(mode: AuthScreenMode.signIn)),
      ),
      GoRoute(
        path: '/auth/sign-up',
        pageBuilder: (context, state) =>
            _appPage(state, const AuthScreen(mode: AuthScreenMode.signUp)),
      ),
      GoRoute(
        path: '/legal/acceptance',
        pageBuilder: (context, state) =>
            _appPage(state, const LegalAcceptanceScreen()),
      ),
      GoRoute(
        path: '/home',
        pageBuilder: (context, state) =>
            _appPage(state, const CreationChatScreen()),
      ),
      GoRoute(
        path: '/account',
        pageBuilder: (context, state) => _appPage(state, const AccountScreen()),
      ),
      GoRoute(
        path: '/books/new',
        pageBuilder: (context, state) {
          final fresh = state.uri.queryParameters['fresh'] == 'true';
          return _appPage(state, CreationChatScreen(startFresh: fresh));
        },
      ),
      GoRoute(
        path: '/books/import',
        pageBuilder: (context, state) =>
            _appPage(state, const ImportBookScreen()),
      ),
      GoRoute(
        path: '/books/chat/:draftId',
        pageBuilder: (context, state) => _appPage(
          state,
          CreationChatScreen(draftId: state.pathParameters['draftId']),
        ),
      ),
      GoRoute(
        path: '/projects/:id',
        pageBuilder: (context, state) => _appPage(
          state,
          BookScreen(
            projectId: state.pathParameters['id']!,
            initialMessage: state.extra is String
                ? state.extra as String
                : null,
          ),
        ),
      ),
      GoRoute(
        // The plan and the progress screens were merged into `/projects/:id`.
        // Kept as a redirect so links saved before that — and any client build
        // still pushing it — land on the book instead of the error page.
        path: '/projects/:id/handoff',
        redirect: (context, state) => '/projects/${state.pathParameters['id']}',
      ),
      GoRoute(
        path: '/projects/:id/read',
        pageBuilder: (context, state) => _appPage(
          state,
          BookReaderScreen(
            projectId: state.pathParameters['id']!,
            // `?page=` is a book page index, not a PDF page: the reader has to
            // find where that page was rendered. Carried in the URL rather than
            // `extra` so the jump survives a deep link.
            openAtBookPage: int.tryParse(
              state.uri.queryParameters['page'] ?? '',
            ),
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/listen',
        pageBuilder: (context, state) => _appPage(
          state,
          AudiobookScreen(projectId: state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        path: '/projects/:id/changes/:operationId',
        pageBuilder: (context, state) => _appPage(
          state,
          EditChangesScreen(
            projectId: state.pathParameters['id']!,
            operationId: state.pathParameters['operationId']!,
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/chat',
        pageBuilder: (context, state) => _appPage(
          state,
          ProjectChatScreen(
            projectId: state.pathParameters['id']!,
            initialDraft: _chatLaunch(state.extra)?.draft,
            initialMessage: _chatLaunch(state.extra)?.send,
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/edit',
        pageBuilder: (context, state) => _appPage(
          state,
          BookEditScreen(
            projectId: state.pathParameters['id']!,
            savedExportMessageId:
                state.uri.queryParameters['savedExportMessageId'],
            initialPageIndex: int.tryParse(
              state.uri.queryParameters['pageIndex'] ?? '',
            ),
          ),
        ),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: AppErrorState(
        title: 'Screen not found',
        message:
            'That link does not point to an available Tomeza screen. Go back to your projects to continue.',
        icon: Icons.explore_off_outlined,
        actionLabel: 'Back to projects',
        actionIcon: Icons.home_outlined,
        onRetry: () => context.go('/home'),
      ),
    ),
  );
  ref.onDispose(router.dispose);
  return router;
});

/// Back-button handling for the whole app.
///
/// [GoRouter] builds its own [RootBackButtonDispatcher] and keeps it in a final
/// field, so the confirm-before-exit one has to be handed to `MaterialApp.router`
/// directly — which is why `app.dart` wires the delegate, parser and provider
/// itself instead of passing `routerConfig`.
final appBackButtonDispatcherProvider = Provider<BackButtonDispatcher>((ref) {
  final router = ref.watch(appRouterProvider);
  return ConfirmExitBackButtonDispatcher(router.routerDelegate.navigatorKey);
});

class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    final error = authState.error;

    if (error != null) {
      return Scaffold(
        body: Center(
          child: AppErrorState(
            title: 'Connection problem',
            message: userFacingError(error),
            actionLabel: 'Retry',
            onRetry: () => ref.invalidate(authControllerProvider),
          ),
        ),
      );
    }

    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Tomeza',
              style: Theme.of(context).textTheme.displaySmall?.copyWith(
                fontWeight: FontWeight.w800,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
            const SizedBox(height: 24),
            const SizedBox.square(
              dimension: 28,
              child: CircularProgressIndicator(
                strokeWidth: 2.5,
                semanticsLabel: 'Restoring your session',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
