import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'plan_build_progress.dart';
import 'project_chat_progress.dart';

/// The book, inside the reply that rebuilt it: "Updating your book…" with a
/// moving bar while the new PDF is made, then "Your book is ready" and Open
/// book. Parsa asked for the button in the reply itself (2026-10-17), so a
/// free change's "Done" ends with the book rather than a separate card.
///
/// While it is updating it stands in for the chat's live progress card, which
/// the transcript leaves out for that time (`chatBookUpdateState`): two busy
/// indicators read as two things happening.
class ChatBookUpdateRow extends StatelessWidget {
  const ChatBookUpdateRow({
    required this.state,
    required this.status,
    required this.foreground,
    required this.onOpen,
    super.key,
  });

  final ChatBookUpdateState state;

  /// The live status, for the bar's percent while updating.
  final MobileProjectStatus? status;
  final Color foreground;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Semantics(
        container: true,
        liveRegion: true,
        child: AppSwitcher(
          alignment: AlignmentDirectional.topStart.resolve(
            Directionality.of(context),
          ),
          child: switch (state) {
            ChatBookUpdateState.updating => _Updating(
              key: const ValueKey('chat-book-updating'),
              status: status,
              foreground: foreground,
            ),
            ChatBookUpdateState.ready => _Ready(
              key: const ValueKey('chat-book-ready'),
              foreground: foreground,
              onOpen: onOpen,
            ),
          },
        ),
      ),
    );
  }
}

class _Updating extends StatelessWidget {
  const _Updating({required this.status, required this.foreground, super.key});

  final MobileProjectStatus? status;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final live = status;
    final percent = live != null && live.isLive ? livePercent(live) : 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            ExcludeSemantics(
              child: PlanBuildSparkle(color: colors.primary, size: 18),
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                'Updating your book…',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: foreground,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.pill),
          // The rebuild reports a percent once its compile is under way; until
          // then the bar moves on its own rather than sitting at zero.
          child: percent <= 0
              ? LinearProgressIndicator(
                  minHeight: 4,
                  color: colors.primary,
                  backgroundColor: colors.primary.withValues(alpha: 0.15),
                  semanticsLabel: 'Updating your book',
                )
              : TweenAnimationBuilder<double>(
                  tween: Tween(end: percent / 100),
                  duration: AppMotion.medium,
                  curve: Curves.easeOutCubic,
                  builder: (context, value, _) => LinearProgressIndicator(
                    value: value,
                    minHeight: 4,
                    color: colors.primary,
                    backgroundColor: colors.primary.withValues(alpha: 0.15),
                    semanticsLabel: 'Updating your book',
                    semanticsValue: '$percent%',
                  ),
                ),
        ),
      ],
    );
  }
}

class _Ready extends StatelessWidget {
  const _Ready({required this.foreground, required this.onOpen, super.key});

  final Color foreground;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Icon(Icons.check_circle_outline, size: 18, color: colors.primary),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                'Your book is ready with this change.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: foreground,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        AppButton.tonal(
          key: const ValueKey('chat-book-open'),
          onPressed: onOpen,
          leading: const Icon(Icons.menu_book_outlined, size: 18),
          label: 'Open book',
        ),
      ],
    );
  }
}
