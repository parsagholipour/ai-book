import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../../projects/presentation/ai_content_report.dart';
import '../../projects/presentation/plan_build_progress.dart'
    show PlanBuildProgressBar, PlanBuildSparkle;
import '../domain/assist_models.dart';
import 'studio_ai_controller.dart';

/// The AI inbox's door in the top bar: a sparkle that turns while anything
/// is being made, and a count of what is waiting to be looked at. Not there
/// at all when the inbox is empty.
class StudioAiInboxButton extends StatelessWidget {
  const StudioAiInboxButton({
    required this.controller,
    required this.onPressed,
    super.key,
  });

  final StudioAiController controller;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final colors = Theme.of(context).colorScheme;
        final inbox = controller.inbox;
        if (inbox.isEmpty) return const SizedBox.shrink();
        final waiting = controller.attentionCount;
        final icon = controller.hasWorking
            ? PlanBuildSparkle(color: colors.primary, size: 22)
            : Icon(Icons.auto_awesome_outlined, color: colors.primary);
        return IconButton(
          key: const ValueKey('studio-ai-inbox'),
          tooltip: waiting == 0
              ? 'AI inbox · working'
              : 'AI inbox · $waiting waiting',
          onPressed: onPressed,
          icon: Badge(
            isLabelVisible: waiting > 0,
            backgroundColor: colors.primary,
            textColor: colors.onPrimary,
            label: Text('$waiting'),
            child: icon,
          ),
        );
      },
    );
  }
}

/// What a finished assist offers to do with its result.
String studioAssistUseLabel(ManuscriptAssist assist) => switch (assist.result) {
  AssistImageResult() => 'Insert',
  AssistNotesResult() => 'Show notes',
  AssistDraftResult() || AssistOutlineResult() => 'Preview',
  null => 'Open',
};

IconData studioAssistIcon(LongAssistKind kind) => switch (kind) {
  LongAssistKind.illustrate => Icons.image_outlined,
  LongAssistKind.draftChapter => Icons.edit_note_rounded,
  LongAssistKind.chapterFeedback => Icons.rate_review_outlined,
  LongAssistKind.consistency => Icons.fact_check_outlined,
  LongAssistKind.outline => Icons.format_list_numbered_rounded,
};

/// The AI inbox: everything the writing assistant is making or has made for
/// this book and the author has not used yet. Working ones show their
/// progress, ready ones offer their result and a discard, failed ones say
/// why. Resolves with the assist the author chose to use, or null.
Future<ManuscriptAssist?> showStudioAiInboxSheet(
  BuildContext context, {
  required StudioAiController controller,
  required String? Function(String? chapterId) chapterLabel,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (sheetContext) => ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final inbox = controller.inbox;
        return AppSheetScaffold(
          title: 'AI inbox',
          subtitle: 'Results wait here until you use or discard them.',
          icon: Icons.inbox_outlined,
          onClose: () => Navigator.of(sheetContext).pop(),
          children: [
            if (inbox.isEmpty)
              const _EmptyInbox()
            else
              for (final assist in inbox)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: _InboxRow(
                    key: ValueKey('studio-inbox-${assist.id}'),
                    projectId: controller.projectId,
                    assist: assist,
                    chapter: chapterLabel(assist.chapterId),
                    onUse: () => Navigator.of(sheetContext).pop(assist),
                    onDiscard: () => controller.dismiss(assist.id),
                  ),
                ),
          ],
        );
      },
    ),
  );
}

class _InboxRow extends ConsumerWidget {
  const _InboxRow({
    required this.projectId,
    required this.assist,
    required this.chapter,
    required this.onUse,
    required this.onDiscard,
    super.key,
  });

  final String projectId;
  final ManuscriptAssist assist;
  final String? chapter;
  final VoidCallback onUse;
  final VoidCallback onDiscard;

  /// A finished suggestion is AI output the author is looking at, so it can be
  /// reported before it is used; the server snapshots the stored result.
  Future<void> _report(BuildContext context, WidgetRef ref) => reportAiContent(
    context: context,
    title: 'Report this AI suggestion',
    submit: (reason, comment) => ref
        .read(aiContentReportsApiProvider)
        .reportStudioAssist(
          projectId: projectId,
          assistId: assist.id,
          reason: reason,
          comment: comment,
        ),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final status = assist.status;
    final result = assist.result;
    final failed = status == ManuscriptAssistStatus.failed;
    final ready = status == ManuscriptAssistStatus.ready && result != null;
    return AppCard(
      density: AppCardDensity.compact,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Thumb(assist: assist),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  assist.kind.label,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (chapter != null)
                  Text(
                    chapter!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                const SizedBox(height: AppSpacing.xs),
                if (status.isWorking) ...[
                  Text(
                    status == ManuscriptAssistStatus.queued
                        ? 'Waiting to start…'
                        : 'Working on it…',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const PlanBuildProgressBar(value: null, height: 5),
                ] else if (failed)
                  Text(
                    assist.error ?? 'This couldn’t be finished.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.error,
                    ),
                  )
                else if (ready)
                  _readyLine(theme, result),
                if (ready || failed) ...[
                  const SizedBox(height: AppSpacing.xs),
                  Wrap(
                    spacing: AppSpacing.xs,
                    runSpacing: AppSpacing.xxs,
                    children: [
                      if (ready)
                        AppButton.tonal(
                          key: ValueKey('studio-inbox-use-${assist.id}'),
                          label: studioAssistUseLabel(assist),
                          onPressed: onUse,
                        ),
                      AppButton.text(
                        key: ValueKey('studio-inbox-discard-${assist.id}'),
                        label: failed ? 'Remove' : 'Discard',
                        onPressed: onDiscard,
                      ),
                      if (ready)
                        AppButton.text(
                          key: ValueKey('studio-inbox-report-${assist.id}'),
                          label: 'Report',
                          leading: const Icon(Icons.flag_outlined, size: 18),
                          onPressed: () => _report(context, ref),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _readyLine(ThemeData theme, AssistResult result) {
    final text = switch (result) {
      AssistImageResult() => 'Ready to go in your chapter',
      AssistDraftResult(:final markdown) =>
        'A draft of about ${_words(markdown)} words',
      AssistNotesResult(:final notes) =>
        notes.isEmpty
            ? 'Nothing to flag'
            : notes.length == 1
            ? '1 note'
            : '${notes.length} notes',
      AssistOutlineResult(:final chapters) =>
        chapters.length == 1 ? '1 chapter' : '${chapters.length} chapters',
    };
    return Text(
      text,
      style: theme.textTheme.labelMedium?.copyWith(
        color: theme.colorScheme.primary,
        fontWeight: FontWeight.w700,
      ),
    );
  }

  static int _words(String markdown) =>
      markdown.split(RegExp(r'\s+')).where((word) => word.isNotEmpty).length;
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.assist});

  final ManuscriptAssist assist;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final result = assist.result;
    final radius = BorderRadius.circular(AppRadii.compact);
    if (result is AssistImageResult && result.url.isNotEmpty) {
      return ClipRRect(
        borderRadius: radius,
        child: AuthedNetworkImage(
          url: result.url,
          cacheBuster: null,
          width: 56,
          height: 56,
          fit: BoxFit.cover,
          semanticLabel: result.alt.isEmpty ? 'Picture' : result.alt,
          loadingPlaceholder: ColoredBox(
            color: colors.surfaceContainerHigh,
            child: const SizedBox.square(dimension: 56),
          ),
          errorPlaceholder: ColoredBox(
            color: colors.surfaceContainerHigh,
            child: SizedBox.square(
              dimension: 56,
              child: Icon(Icons.image_outlined, color: colors.outline),
            ),
          ),
        ),
      );
    }
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: colors.primaryContainer.withValues(alpha: 0.6),
        borderRadius: radius,
      ),
      child: Icon(studioAssistIcon(assist.kind), color: colors.primary),
    );
  }
}

class _EmptyInbox extends StatelessWidget {
  const _EmptyInbox();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
      child: Column(
        children: [
          Icon(
            Icons.inbox_outlined,
            size: 32,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            'Nothing waiting. Pictures, drafts and notes you ask for land '
            'here if you’re elsewhere when they’re ready.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
