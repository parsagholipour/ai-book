import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/creation_chat_navigation.dart';
import '../../projects/presentation/plan_build_progress.dart';
import '../data/book_share_repository.dart';
import '../data/pending_remix.dart';

/// Where "Make a book like this" lands: it fetches the shared book's format
/// and replaces itself with a new creation chat set up from it.
///
/// Not a stop on the way — the reader never has anything to do here. While
/// the format loads it shows that something is being set up; once it has
/// arrived the chat takes this screen's place, so Back never returns to it. A
/// link to a book that is no longer shared says so and offers a new book of
/// the reader's own instead, which is what they came to make.
class RemixScreen extends ConsumerStatefulWidget {
  const RemixScreen({required this.slug, super.key});

  final String slug;

  @override
  ConsumerState<RemixScreen> createState() => _RemixScreenState();
}

class _RemixScreenState extends ConsumerState<RemixScreen> {
  Object? _error;

  @override
  void initState() {
    super.initState();
    // The link has reached the screen it was held for.
    ref.read(pendingRemixProvider).clear();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_error != null) setState(() => _error = null);
    try {
      final remix = await ref
          .read(bookShareRepositoryProvider)
          .loadRemix(widget.slug);
      if (!mounted) return;
      context.go(newBookChatLocation(), extra: remix);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  void _startOwnBook() => context.go(newBookChatLocation());

  @override
  Widget build(BuildContext context) {
    final error = _error;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: AppSwitcher(
              child: switch (error) {
                null => const _RemixLoading(key: ValueKey('remix-loading')),
                _ when isRemixGone(error) => AppEmptyState(
                  key: const ValueKey('remix-gone'),
                  icon: Icons.link_off_outlined,
                  title: 'This book is no longer shared',
                  message:
                      'Its author stopped sharing it, so there is no format '
                      'to start from. You can still make a book of your own.',
                  actionLabel: 'Start a new book',
                  actionIcon: const Icon(Icons.add),
                  onAction: _startOwnBook,
                ),
                _ => AppErrorState(
                  key: const ValueKey('remix-error'),
                  title: 'Couldn’t open this book',
                  message: userFacingError(error),
                  onRetry: () => unawaited(_load()),
                  secondaryLabel: 'Start a new book',
                  onSecondary: _startOwnBook,
                ),
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Whether [error] says the share behind a remix link is gone for good,
/// rather than that it could not be reached this time.
bool isRemixGone(Object error) =>
    error is ApiException &&
    (error.statusCode == 404 ||
        error.statusCode == 410 ||
        error.code == 'SHARE_NOT_FOUND' ||
        error.code == 'REMIX_NOT_AVAILABLE');

/// The short wait while the format arrives: the planner's working sparkle and
/// a band sweeping a track, never a bare spinner.
class _RemixLoading extends StatelessWidget {
  const _RemixLoading({super.key});

  static const message = 'Setting up a book like this one';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: message,
      child: ExcludeSemantics(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(
                color: colors.primaryContainer.withValues(alpha: 0.55),
                shape: BoxShape.circle,
              ),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: PlanBuildSparkle(color: colors.primary, size: 40),
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            const SizedBox(
              width: 160,
              child: PlanBuildProgressBar(value: null, height: 6),
            ),
          ],
        ),
      ),
    );
  }
}
