import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/account/presentation/account_screen.dart';
import '../../features/auth/presentation/auth_controller.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/projects/presentation/creation_chat_screen.dart';
import '../../features/projects/presentation/generation_progress_screen.dart';
import '../../features/projects/presentation/project_detail_screen.dart';
import '../../features/projects/presentation/projects_home_screen.dart';
import '../../shared/ui/feedback/app_feedback.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authControllerProvider);

  return GoRouter(
    initialLocation: '/home',
    redirect: (context, state) {
      final path = state.uri.path;
      final isAuthRoute = path.startsWith('/auth');
      final isSplash = path == '/splash';
      final currentSession = authState.asData?.value;
      final hasSession = currentSession != null;

      if (authState.isLoading && currentSession == null) {
        return isAuthRoute || isSplash ? null : '/splash';
      }

      if (!hasSession) {
        return isAuthRoute ? null : '/auth/sign-in';
      }

      if (isAuthRoute || isSplash) {
        return '/home';
      }

      return null;
    },
    routes: [
      GoRoute(
        path: '/splash',
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: '/auth/sign-in',
        builder: (context, state) =>
            const AuthScreen(mode: AuthScreenMode.signIn),
      ),
      GoRoute(
        path: '/auth/sign-up',
        builder: (context, state) =>
            const AuthScreen(mode: AuthScreenMode.signUp),
      ),
      GoRoute(
        path: '/home',
        builder: (context, state) => const ProjectsHomeScreen(),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) => const AccountScreen(),
      ),
      GoRoute(
        path: '/books/new',
        builder: (context, state) => const CreationChatScreen(),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            ProjectDetailScreen(projectId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/projects/:id/handoff',
        builder: (context, state) => GenerationProgressScreen(
          projectId: state.pathParameters['id']!,
          initialMessage: state.extra as String?,
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
});

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: SizedBox.square(
          dimension: 32,
          child: CircularProgressIndicator(
            semanticsLabel: 'Restoring your session',
          ),
        ),
      ),
    );
  }
}
