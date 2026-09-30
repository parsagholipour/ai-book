import 'dart:math' as math;

import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/account/presentation/account_plan_screen.dart';
import '../../features/account/presentation/account_privacy_screen.dart';
import '../../features/account/presentation/account_screen.dart';
import '../../features/account/presentation/archived_chats_screen.dart';
import '../../features/billing/presentation/credit_log_screen.dart';
import '../../features/auth/domain/legal_gate.dart';
import '../../features/auth/presentation/auth_controller.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/auth/presentation/forgot_password_screen.dart';
import '../../features/auth/presentation/legal_acceptance_screen.dart';
import '../../features/auth/presentation/sample_book_screen.dart';
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
import '../../features/studio/presentation/studio_screen.dart';
import '../../shared/api/api_error.dart';
import '../../shared/ui/app_components.dart';
import '../../shared/ui/feedback/app_feedback.dart';
import '../../shared/ui/motion.dart';
import 'exit_confirmation.dart';

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
        // The sample book is the one signed-out destination besides auth:
        // reading it is how someone decides to create an account at all.
        return isAuthRoute || path == '/sample-book' ? null : '/auth/sign-in';
      }

      if (currentSession.user.legalAcceptanceRequired) {
        // The gate mirrors the server: reads stay open while re-acceptance is
        // outstanding, only writes are refused. "Not now" dismisses the gate
        // for this session; a refused write un-dismisses it (see the
        // legalGateDismissedProvider listener above).
        if (!ref.read(legalGateDismissedProvider)) {
          return isLegalAcceptance || path.startsWith('/account')
              ? null
              : '/legal/acceptance';
        }
        return isAuthRoute || isSplash ? '/home' : null;
      }

      if (isAuthRoute || isSplash || isLegalAcceptance) {
        return '/home';
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
            ),
          );
        },
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

/// The first thing every launch shows while the saved session is restored, and
/// the place a failed restore stops with a way to try again.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    // A retry keeps the error it is retrying, so "has an error" alone would
    // show the same screen with no sign that anything is happening.
    final error = authState.error;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: error != null
                  ? _SplashRetry(
                      error: error,
                      retrying: authState.isLoading,
                      onRetry: () => ref.invalidate(authControllerProvider),
                    )
                  : const _SplashLoading(),
            ),
          ),
        ),
      ),
    );
  }
}

/// Restoring the session: the brand mark breathing, a slim bar sweeping under
/// it, and a plainer line once it is taking longer than it should.
///
/// One controller drives all of it and runs for a bounded stretch, so a screen
/// left open does not animate for ever: after half a minute it stops on the
/// last honest sentence.
class _SplashLoading extends StatefulWidget {
  const _SplashLoading();

  @override
  State<_SplashLoading> createState() => _SplashLoadingState();
}

class _SplashLoadingState extends State<_SplashLoading>
    with SingleTickerProviderStateMixin {
  static const _span = Duration(seconds: 30);
  static const _breath = Duration(milliseconds: 1800);
  static const _sweep = Duration(milliseconds: 1400);
  static const _slowAfter = Duration(seconds: 6);

  late final AnimationController _clock = AnimationController(
    vsync: this,
    duration: _span,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    // Reduced motion still gets the slow-connection line; it just holds the
    // mark and the bar still.
    _clock.forward();
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final reduced = AppMotion.reducedMotion(context);

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Restoring your session',
      child: ExcludeSemantics(
        child: AnimatedBuilder(
          animation: _clock,
          builder: (context, _) {
            final elapsed = _span * _clock.value;
            final breathe = reduced
                ? 0.0
                : 0.5 -
                      0.5 *
                          math.cos(
                            2 *
                                math.pi *
                                elapsed.inMicroseconds /
                                _breath.inMicroseconds,
                          );
            final sweep = reduced
                ? 0.35
                : (elapsed.inMicroseconds % _sweep.inMicroseconds) /
                      _sweep.inMicroseconds;
            final slow = elapsed >= _slowAfter;
            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox.square(
                  dimension: 112,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      // A halo that swells as the mark lifts and fades as it
                      // settles: the "alive" cue, without a spinner.
                      Transform.scale(
                        scale: 0.8 + 0.2 * breathe,
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: colors.primary.withValues(
                              alpha: 0.06 + 0.06 * (1 - breathe),
                            ),
                          ),
                          child: const SizedBox.square(dimension: 112),
                        ),
                      ),
                      Transform.scale(
                        scale: 1 + 0.05 * breathe,
                        child: const TomezaBrandMark(size: 60),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Tomeza',
                  style: theme.textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.5,
                  ),
                ),
                const SizedBox(height: 28),
                _SweepBar(position: sweep),
                const SizedBox(height: 16),
                AnimatedSwitcher(
                  duration: reduced ? Duration.zero : AppMotion.medium,
                  child: Text(
                    slow
                        ? 'Still connecting. This is taking longer than usual.'
                        : 'Getting your library ready',
                    key: ValueKey(slow),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// A short bar sliding along a rounded track, cycling at the caller's pace.
class _SweepBar extends StatelessWidget {
  const _SweepBar({required this.position});

  /// 0..1 across one sweep.
  final double position;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    const width = 132.0;
    const segment = 44.0;
    // The segment enters from beyond the left edge and leaves past the right,
    // clipped by the track, so it never pops in or out.
    final left =
        -segment + (width + segment) * Curves.easeInOut.transform(position);
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadii.pill),
      child: SizedBox(
        width: width,
        height: 4,
        child: Stack(
          children: [
            Positioned.fill(
              child: ColoredBox(color: colors.primary.withValues(alpha: 0.14)),
            ),
            Positioned(
              left: left,
              width: segment,
              top: 0,
              bottom: 0,
              child: ColoredBox(color: colors.primary),
            ),
          ],
        ),
      ),
    );
  }
}

/// A failed restore: what happened, that nothing is lost, and one obvious way
/// forward that shows it is working once it has been pressed.
class _SplashRetry extends StatelessWidget {
  const _SplashRetry({
    required this.error,
    required this.retrying,
    required this.onRetry,
  });

  final Object error;
  final bool retrying;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final offline =
        error is ApiException &&
        (error as ApiException).code == 'NETWORK_ERROR';
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        TomezaWordmark(
          markSize: 32,
          textStyle: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 36),
        ExcludeSemantics(
          child: Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: colors.errorContainer.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(AppRadii.card),
            ),
            child: Icon(
              offline ? Icons.wifi_off_outlined : Icons.cloud_off_outlined,
              color: colors.error,
              size: 30,
            ),
          ),
        ),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          liveRegion: true,
          child: Text(
            'Connection problem',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          userFacingError(error),
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 24),
        AppButton.primary(
          label: 'Retry',
          loading: retrying,
          loadingLabel: 'Retrying',
          expanded: true,
          leading: const Icon(Icons.refresh),
          onPressed: onRetry,
        ),
        const SizedBox(height: 16),
        Text(
          'Your books are saved and will be here as soon as you are back online.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
