import 'package:flutter/material.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';

class ProjectRouteErrorState extends StatelessWidget {
  const ProjectRouteErrorState({
    required this.error,
    required this.fallbackTitle,
    required this.onRetry,
    required this.onGoHome,
    super.key,
  });

  final Object error;
  final String fallbackTitle;
  final VoidCallback onRetry;
  final VoidCallback onGoHome;

  @override
  Widget build(BuildContext context) {
    final routeError = _ProjectRouteError.from(error);
    if (routeError != null) {
      return AppErrorState(
        title: routeError.title,
        message: routeError.message,
        icon: routeError.icon,
        actionLabel: 'Back to projects',
        actionIcon: Icons.home_outlined,
        onRetry: onGoHome,
      );
    }

    return AppErrorState(
      title: fallbackTitle,
      message: userFacingError(error),
      onRetry: onRetry,
    );
  }
}

class _ProjectRouteError {
  const _ProjectRouteError({
    required this.title,
    required this.message,
    required this.icon,
  });

  final String title;
  final String message;
  final IconData icon;

  static _ProjectRouteError? from(Object error) {
    if (error is! ApiException) {
      return null;
    }

    if (error.statusCode == 404 ||
        error.code == 'PROJECT_NOT_FOUND' ||
        error.code == 'PLAN_NOT_FOUND') {
      return const _ProjectRouteError(
        title: 'Book not found',
        message:
            'This book may have been deleted, moved, or opened from a link that no longer works.',
        icon: Icons.menu_book_outlined,
      );
    }

    if (error.statusCode == 403) {
      return const _ProjectRouteError(
        title: 'Book not available',
        message:
            'This book belongs to another account or cannot be opened from this session.',
        icon: Icons.lock_outline,
      );
    }

    return null;
  }
}
