import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/account/presentation/account_plan_screen.dart';
import '../../features/account/presentation/account_privacy_screen.dart';
import '../../features/account/presentation/account_screen.dart';
import '../../features/account/presentation/archived_chats_screen.dart';
import '../../features/book_matter/presentation/author_profile_screen.dart';
import '../../features/billing/presentation/credit_log_screen.dart';
import '../../features/app_update/domain/app_update.dart';
import '../../features/app_update/presentation/app_update_required_screen.dart';
import '../../features/auth/data/pending_location.dart';
import '../../features/auth/domain/legal_gate.dart';
import '../../features/auth/presentation/auth_controller.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/auth/presentation/forgot_password_screen.dart';
import '../../features/auth/presentation/legal_acceptance_screen.dart';
import '../../features/auth/presentation/sample_book_screen.dart';
import '../../features/auth/presentation/verify_email_location.dart';
import '../../features/auth/presentation/verify_email_screen.dart';
import '../../features/projects/presentation/book_edit_screen.dart';
import '../../features/projects/presentation/book_library_screen.dart';
import '../../features/projects/presentation/book_screen.dart';
import '../../features/projects/presentation/creation_chat_screen.dart';
import '../../features/projects/presentation/edit_changes_screen.dart';
import '../../features/projects/presentation/import_book_screen.dart';
import '../../features/projects/presentation/project_chat_screen.dart';
import '../../features/audiobook/presentation/audiobook_screen.dart';
import '../../features/notes/presentation/book_note_editor_screen.dart';
import '../../features/notes/presentation/book_notes_screen.dart';
import '../../features/notes/presentation/notes_location.dart';
import '../../features/reader/presentation/book_reader_screen.dart';
import '../../features/sharing/data/pending_remix.dart';
import '../../features/sharing/domain/book_remix.dart';
import '../../features/sharing/presentation/remix_location.dart';
import '../../features/sharing/presentation/remix_screen.dart';
import '../../features/studio/presentation/studio_screen.dart';
import '../../shared/api/api_error.dart';
import '../../shared/ui/feedback/app_feedback.dart';
import '../../shared/ui/motion.dart';
import '../launch/launch_screen.dart';
import 'exit_confirmation.dart';

/// A link received while platform services were starting. Null leaves the
/// router's normal platform initial-route handling in charge.
final initialAppLocationProvider = Provider<String?>((ref) => null);

/// Screen transition used for every route.
///
/// Going deeper (library -> book -> reader) is a shared-axis move: the new page
/// eases in from the side the reader reads toward while fading up, and the page
/// beneath drifts a little the other way, so the two read as one surface with
/// depth instead of two screens swapping. Top-level destinations (home, the
/// auth screens, the splash) fade through with a barely-there scale, because
/// nothing is "beneath" them to move away from. Both drop the movement when the
/// platform asks for reduced motion.
///
/// The pages are driven by the route's own animation, which the framework also
/// scrubs during a back gesture, so swipe-back and Android's predictive back
/// follow the finger through the same curves. iOS keeps its native edge-swipe
/// transition, which a custom builder would otherwise take away.
CustomTransitionPage<void> _appPage(GoRouterState state, Widget child) {
  return _page(state, child, _TransitionKind.sharedAxis);
}

/// A top-level destination: fades through instead of sliding, see [_appPage].
CustomTransitionPage<void> _rootPage(GoRouterState state, Widget child) {
  return _page(state, child, _TransitionKind.fadeThrough);
}

enum _TransitionKind { sharedAxis, fadeThrough }

CustomTransitionPage<void> _page(
  GoRouterState state,
  Widget child,
  _TransitionKind kind,
) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionDuration: AppMotion.page,
    // Leaving is quicker than arriving: the reader has already decided.
    reverseTransitionDuration: const Duration(milliseconds: 200),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final platform = Theme.of(context).platform;
      final route = ModalRoute.of(context);
      if ((platform == TargetPlatform.iOS ||
              platform == TargetPlatform.macOS) &&
          route is PageRoute<void>) {
        return const CupertinoPageTransitionsBuilder().buildTransitions<void>(
          route,
          context,
          animation,
          secondaryAnimation,
          child,
        );
      }
      final reduced = AppMotion.reducedMotion(context);
      // `drive` with a CurveTween, not a CurvedAnimation: nothing here has to be
      // disposed, and the same curve on the way out reads as an ease-in, which
      // is what a page leaving should do.
      final fade = animation.drive(
        CurveTween(curve: const Interval(0, 0.7, curve: Curves.easeOut)),
      );
      if (reduced) {
        return FadeTransition(opacity: fade, child: child);
      }
      final move = animation.drive(
        CurveTween(curve: AppMotion.enterEmphasized),
      );
      // Toward the reading direction: left in right-to-left scripts.
      final direction = Directionality.of(context) == TextDirection.rtl
          ? -1.0
          : 1.0;
      final arriving = switch (kind) {
        _TransitionKind.fadeThrough => FadeTransition(
          opacity: fade,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.97, end: 1).animate(move),
            child: child,
          ),
        ),
        _TransitionKind.sharedAxis => FadeTransition(
          opacity: fade,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: Offset(0.08 * direction, 0),
              end: Offset.zero,
            ).animate(move),
            child: child,
          ),
        ),
      };
      // Whatever page a new one is pushed over drifts a little the other way.
      // It is only moved, never faded, so nothing but the page that is
      // arriving ever shows the window behind the navigator.
      return SlideTransition(
        position:
            Tween<Offset>(
              begin: Offset.zero,
              end: Offset(-0.06 * direction, 0),
            ).animate(
              secondaryAnimation.drive(CurveTween(curve: AppMotion.standard)),
            ),
        child: arriving,
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
  // A 428 from any write clears the gate dismissal, and the redirect below
  // must re-run right then to walk the reader back to the terms screen.
  ref.listen(legalGateDismissedProvider, (_, _) {
    authRefresh.value += 1;
  });
  // A retired build is sent to the update screen the moment the check or any
  // refused request says so, and released from it the same way.
  ref.listen(appUpdateStatusProvider.select((status) => status.isRequired), (
    _,
    _,
  ) {
    authRefresh.value += 1;
  });
  ref.onDispose(authRefresh.dispose);

  final router = GoRouter(
    initialLocation: ref.read(initialAppLocationProvider) ?? '/home',
    overridePlatformDefaultLocation:
        ref.read(initialAppLocationProvider) != null,
    refreshListenable: authRefresh,
    redirect: (context, state) {
      // "Make a book like this" arrives as the whole `tomeza://remix/<slug>`
      // URI. Becoming `/remix/<slug>` here sends it back through this
      // redirect, where the rules below apply to it like any other location.
      final remixDeepLink = remixLocationForDeepLink(state.uri);
      if (remixDeepLink != null) return remixDeepLink;

      // Ahead of everything else, signed in or not: the server refuses every
      // mobile request from a build it requires to update.
      final isUpdateRequired = state.uri.path == '/update-required';
      if (ref.read(appUpdateStatusProvider).isRequired) {
        return isUpdateRequired ? null : '/update-required';
      }
      if (isUpdateRequired) return '/home';

      final authState = ref.read(authControllerProvider);
      final path = state.uri.path;
      final isAuthRoute = path.startsWith('/auth');
      final isSplash = path == '/splash';
      final isLegalAcceptance = path == '/legal/acceptance';
      final currentSession = authState.asData?.value;
      final hasSession = currentSession != null;

      // A remix link that has to wait — for the splash, for signing in, for
      // the terms — is held until the remix screen opens (which clears it),
      // and wherever the reader would have landed afterwards is that screen
      // instead. It is only ever peeked here, never taken: one navigation can
      // run this redirect twice for the same location, and the second run has
      // to reach the same answer as the first. Any other screen a cold start
      // was opened on (`/books`, `/projects/<id>`) is held the same way by
      // [PendingLocation], and let go once a page past the gates is shown
      // (the delegate listener below).
      final pendingRemix = ref.read(pendingRemixProvider);
      final pendingLocation = ref.read(pendingLocationProvider);
      final remixSlug = remixSlugFromPath(path);
      String detour(String location) {
        if (remixSlug != null) {
          pendingRemix.remember(remixSlug);
        } else {
          pendingLocation.remember(state.uri);
        }
        return location;
      }

      String landing() {
        // A new email account opens on its code first; the verify screen
        // walks on to the remix, the opened screen or home when the reader
        // is done there.
        if (ref.read(verifyEmailAfterSignUpProvider).pending &&
            currentSession?.user.emailVerified == false) {
          return verifyEmailLocation(codeSent: true);
        }
        return landingLocation(pendingRemix, pendingLocation);
      }

      if (authState.isLoading && currentSession == null) {
        return isAuthRoute || isSplash ? null : detour('/splash');
      }

      // Only a restore with nothing on this phone to fall back on errors
      // here: one that merely could not reach the server opens the stored
      // session offline instead (`MobileAuthRepository.restoreSession`), so
      // downloaded books and narrations open on a plane.
      if (authState.hasError && currentSession == null) {
        return isAuthRoute || isSplash ? null : detour('/splash');
      }

      if (!hasSession) {
        // The sample book is the one signed-out destination besides auth:
        // reading it is how someone decides to create an account at all.
        return isAuthRoute || path == '/sample-book'
            ? null
            : detour('/auth/sign-in');
      }

      if (currentSession.user.legalAcceptanceRequired) {
        // The gate mirrors the server: reads stay open while re-acceptance is
        // outstanding, only writes are refused. "Not now" dismisses the gate
        // for this session; a refused write un-dismisses it (see the
        // legalGateDismissedProvider listener above).
        if (!ref.read(legalGateDismissedProvider)) {
          return isLegalAcceptance || path.startsWith('/account')
              ? null
              : detour('/legal/acceptance');
        }
        return isAuthRoute || isSplash ? landing() : null;
      }

      if (isAuthRoute || isSplash || isLegalAcceptance) {
        return landing();
      }

      return null;
    },
    routes: [
      GoRoute(
        path: '/splash',
        pageBuilder: (context, state) => _rootPage(state, const SplashScreen()),
      ),
      GoRoute(
        path: '/auth/sign-in',
        pageBuilder: (context, state) =>
            _rootPage(state, const AuthScreen(mode: AuthScreenMode.signIn)),
      ),
      GoRoute(
        path: '/auth/sign-up',
        pageBuilder: (context, state) =>
            _rootPage(state, const AuthScreen(mode: AuthScreenMode.signUp)),
      ),
      GoRoute(
        path: '/auth/forgot-password',
        pageBuilder: (context, state) => _appPage(
          state,
          ForgotPasswordScreen(
            initialEmail: state.extra is String ? state.extra as String : null,
          ),
        ),
      ),
      GoRoute(
        path: '/update-required',
        pageBuilder: (context, state) =>
            _rootPage(state, const AppUpdateRequiredScreen()),
      ),
      GoRoute(
        path: '/legal/acceptance',
        pageBuilder: (context, state) =>
            _rootPage(state, const LegalAcceptanceScreen()),
      ),
      GoRoute(
        path: '/sample-book',
        pageBuilder: (context, state) =>
            _appPage(state, const SampleBookScreen()),
      ),
      GoRoute(
        path: '/home',
        pageBuilder: (context, state) =>
            _rootPage(state, const CreationChatScreen()),
      ),
      GoRoute(
        path: '/account',
        pageBuilder: (context, state) => _appPage(state, const AccountScreen()),
      ),
      GoRoute(
        path: '/account/plan',
        pageBuilder: (context, state) =>
            _appPage(state, const AccountPlanScreen()),
      ),
      GoRoute(
        path: '/account/privacy',
        pageBuilder: (context, state) =>
            _appPage(state, const AccountPrivacyScreen()),
      ),
      GoRoute(
        path: '/account/archived-chats',
        pageBuilder: (context, state) =>
            _appPage(state, const ArchivedChatsScreen()),
      ),
      GoRoute(
        path: authorProfileLocation,
        pageBuilder: (context, state) =>
            _appPage(state, const AuthorProfileScreen()),
      ),
      GoRoute(
        path: verifyEmailPath,
        pageBuilder: (context, state) => _appPage(
          state,
          VerifyEmailScreen(
            codeAlreadySent: state.uri.queryParameters['sent'] == '1',
          ),
        ),
      ),
      GoRoute(
        path: '/account/credit-history',
        pageBuilder: (context, state) =>
            _appPage(state, const CreditLogScreen()),
      ),
      GoRoute(
        path: '/books',
        pageBuilder: (context, state) =>
            _appPage(state, const BookLibraryScreen()),
      ),
      GoRoute(
        path: '/books/new',
        pageBuilder: (context, state) {
          final fresh = state.uri.queryParameters['fresh'] == 'true';
          return _rootPage(
            state,
            CreationChatScreen(
              startFresh: fresh,
              // Carries the nonce from newBookChatLocation() so the screen's
              // didUpdateWidget can tell two "New book" taps apart even
              // though startFresh/draftId are identical both times.
              resetToken: state.uri.queryParameters['r'],
              // Handed over by the remix screen once the format has arrived.
              remix: state.extra is BookRemix ? state.extra as BookRemix : null,
            ),
          );
        },
      ),
      GoRoute(
        // "Make a book like this": fetches the shared book's format, then
        // replaces itself with a new chat. See `remix_location.dart`.
        path: '/remix/:slug',
        pageBuilder: (context, state) =>
            _rootPage(state, RemixScreen(slug: state.pathParameters['slug']!)),
      ),
      GoRoute(
        path: '/books/import',
        pageBuilder: (context, state) =>
            _appPage(state, const ImportBookScreen()),
      ),
      GoRoute(
        path: '/books/chat/:draftId',
        pageBuilder: (context, state) => _rootPage(
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
            initialReaderContext: _chatLaunch(state.extra)?.readerContext,
          ),
        ),
      ),
      GoRoute(
        // The Writing Studio. `?chapter=` opens that chapter (default: the
        // one written in last); `?publish=1` opens the publish sheet on load.
        path: '/projects/:id/write',
        pageBuilder: (context, state) => _appPage(
          state,
          StudioScreen(
            projectId: state.pathParameters['id']!,
            chapterId: state.uri.queryParameters['chapter'],
            openPublish: state.uri.queryParameters['publish'] == '1',
          ),
        ),
      ),
      GoRoute(
        // The book's private notebook. See `bookNotesLocation`.
        path: '/projects/:id/notes',
        pageBuilder: (context, state) => _appPage(
          state,
          BookNotesScreen(projectId: state.pathParameters['id']!),
        ),
      ),
      GoRoute(
        // One note; `new` opens a blank one, created once it has words.
        path: '/projects/:id/notes/:noteId',
        pageBuilder: (context, state) {
          final noteId = state.pathParameters['noteId']!;
          return _appPage(
            state,
            BookNoteEditorScreen(
              projectId: state.pathParameters['id']!,
              noteId: noteId == newBookNoteId ? null : noteId,
            ),
          );
        },
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
  // The detour is over once a page past the gates has been shown with a
  // session: the screen the app was opened on, or whatever took priority over
  // it. Settled here, after the navigation committed, rather than in the
  // redirect, which may run twice for one location.
  void settlePendingLocation() {
    if (ref.read(authControllerProvider).asData?.value == null) return;
    final configuration = router.routerDelegate.currentConfiguration;
    if (configuration.isEmpty) return;
    if (isDetourPath(configuration.uri.path)) return;
    ref.read(pendingLocationProvider).settle();
  }

  router.routerDelegate.addListener(settlePendingLocation);
  ref.onDispose(() {
    router.routerDelegate.removeListener(settlePendingLocation);
    router.dispose();
  });
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

/// Session restoration shares the launch page used during platform startup.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    final error = authState.error;
    return LaunchScreen(
      errorMessage: error == null ? null : userFacingError(error),
      retrying: authState.isLoading,
      onRetry: () => ref.invalidate(authControllerProvider),
    );
  }
}
