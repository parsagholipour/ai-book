import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/chat_history_time.dart';
import '../../projects/presentation/chat_message_text.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';

/// Lists the kept versions of one chapter and previews them. Resolves with the
/// version the author chose to restore, or null. The caller applies it (it
/// owns the editor's text and saves with `checkpoint: restore`).
///
/// Nothing is restored from the list itself: a version is read before it
/// replaces anything, so the author sees what they are going back to.
Future<ManuscriptVersion?> showVersionHistorySheet(
  BuildContext context, {
  required String projectId,
  required String chapterId,
}) {
  return showAppBottomSheet<ManuscriptVersion>(
    context,
    builder: (_) =>
        VersionHistorySheet(projectId: projectId, chapterId: chapterId),
  );
}

@visibleForTesting
class VersionHistorySheet extends ConsumerStatefulWidget {
  const VersionHistorySheet({
    required this.projectId,
    required this.chapterId,
    super.key,
  });

  final String projectId;
  final String chapterId;

  @override
  ConsumerState<VersionHistorySheet> createState() =>
      _VersionHistorySheetState();
}

class _VersionHistorySheetState extends ConsumerState<VersionHistorySheet> {
  ManuscriptVersionSummary? _selected;
  Future<ManuscriptVersion>? _version;

  ManuscriptChapterRef get _ref =>
      (projectId: widget.projectId, chapterId: widget.chapterId);

  void _open(ManuscriptVersionSummary summary) {
    AppHaptics.selection();
    setState(() {
      _selected = summary;
      _version = ref
          .read(studioRepositoryProvider)
          .getVersion(widget.projectId, widget.chapterId, summary.id);
    });
  }

  void _back() {
    setState(() {
      _selected = null;
      _version = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final selected = _selected;
    return PopScope(
      // Back from a preview returns to the list rather than closing the sheet.
      canPop: selected == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: AppSheetScaffold(
        title: 'Version history',
        subtitle: selected == null
            ? 'Earlier copies of this chapter, kept as you write.'
            : null,
        icon: Icons.history,
        onClose: () => Navigator.of(context).pop(),
        footer: selected == null ? null : _restoreFooter(),
        children: [
          AppSwitcher(
            child: selected == null
                ? _VersionList(
                    key: const ValueKey('version-list'),
                    versions: ref.watch(manuscriptVersionsProvider(_ref)),
                    onOpen: _open,
                    onRetry: () =>
                        ref.invalidate(manuscriptVersionsProvider(_ref)),
                  )
                : _VersionPreview(
                    key: ValueKey('version-preview-${selected.id}'),
                    summary: selected,
                    version: _version!,
                    onBack: _back,
                  ),
          ),
        ],
      ),
    );
  }

  Widget _restoreFooter() {
    return FutureBuilder<ManuscriptVersion>(
      future: _version,
      builder: (context, snapshot) {
        final version = snapshot.data;
        return AppButton.primary(
          key: const ValueKey('version-restore'),
          label: 'Restore this version',
          leading: const Icon(Icons.restore),
          expanded: true,
          onPressed: version == null
              ? null
              : () {
                  AppHaptics.tap();
                  Navigator.of(context).pop(version);
                },
        );
      },
    );
  }
}

class _VersionList extends StatelessWidget {
  const _VersionList({
    required this.versions,
    required this.onOpen,
    required this.onRetry,
    super.key,
  });

  final AsyncValue<List<ManuscriptVersionSummary>> versions;
  final ValueChanged<ManuscriptVersionSummary> onOpen;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final value = versions;
    if (value.hasError && !value.hasValue) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppInlineNotice(
            tone: AppTone.error,
            title: 'Could not load versions',
            message: userFacingError(value.error!),
            actionLabel: 'Try again',
            onAction: onRetry,
          ),
        ],
      );
    }
    final list = value.value;
    if (list == null) {
      return AppSkeletonGroup(
        label: 'Loading versions',
        child: Column(
          children: [
            for (var i = 0; i < 4; i++) ...[
              const _VersionRowSkeleton(),
              const SizedBox(height: AppSpacing.xs),
            ],
          ],
        ),
      );
    }
    if (list.isEmpty) return const _NoVersions();
    final sorted = [...list]
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final version in sorted) ...[
          _VersionRow(version: version, onTap: () => onOpen(version)),
          const SizedBox(height: AppSpacing.xs),
        ],
      ],
    );
  }
}

/// "12m ago · 14:05": how long ago, and the time on the clock, because two
/// autosaves an hour apart both read "Today".
String versionTimeLabel(BuildContext context, DateTime at, {DateTime? now}) {
  final localizations = MaterialLocalizations.of(context);
  final local = at.toLocal();
  final relative = relativeChatTime(
    at,
    now: now ?? DateTime.now(),
    localizations: localizations,
  );
  final clock = localizations.formatTimeOfDay(
    TimeOfDay.fromDateTime(local),
    alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
  );
  return '$relative · $clock';
}

IconData _reasonIcon(ManuscriptVersionReason reason) => switch (reason) {
  ManuscriptVersionReason.auto => Icons.save_outlined,
  ManuscriptVersionReason.beforeAi => Icons.auto_awesome_outlined,
  ManuscriptVersionReason.restore => Icons.restore,
  ManuscriptVersionReason.publish => Icons.menu_book_outlined,
  ManuscriptVersionReason.conflict => Icons.call_split,
};

String _wordsLabel(BuildContext context, int words) {
  final count = MaterialLocalizations.of(context).formatDecimal(words);
  return words == 1 ? '1 word' : '$count words';
}

class _VersionRow extends StatelessWidget {
  const _VersionRow({required this.version, required this.onTap});

  final ManuscriptVersionSummary version;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final when = versionTimeLabel(context, version.createdAt);
    final detail =
        '${version.reason.label} · ${_wordsLabel(context, version.wordCount)}';
    final published = version.reason == ManuscriptVersionReason.publish;
    return Semantics(
      button: true,
      label: '$when. $detail',
      child: ExcludeSemantics(
        child: Material(
          color: colors.surfaceContainerLow,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.control),
            side: BorderSide(color: colors.outlineVariant),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: ValueKey('version-row-${version.id}'),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.sm,
                AppSpacing.sm,
                AppSpacing.xs,
                AppSpacing.sm,
              ),
              child: Row(
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: published
                          ? colors.primaryContainer
                          : colors.surfaceContainerHigh,
                      shape: BoxShape.circle,
                    ),
                    child: SizedBox.square(
                      dimension: 36,
                      child: Icon(
                        _reasonIcon(version.reason),
                        size: 19,
                        color: published
                            ? colors.onPrimaryContainer
                            : colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          when,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.chevron_right, color: colors.onSurfaceVariant),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _VersionRowSkeleton extends StatelessWidget {
  const _VersionRowSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(AppSpacing.sm),
      child: Row(
        children: [
          AppSkeleton.circle(size: 36),
          SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppSkeleton.line(widthFactor: 0.45, height: 14),
                SizedBox(height: 6),
                AppSkeleton.line(widthFactor: 0.7),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NoVersions extends StatelessWidget {
  const _NoVersions();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
      child: Column(
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: colors.primaryContainer.withValues(alpha: 0.7),
              shape: BoxShape.circle,
            ),
            child: SizedBox.square(
              dimension: 56,
              child: Icon(Icons.history, color: colors.primary, size: 28),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            'No earlier versions yet',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            'Versions are kept automatically as you write — every so often '
            'while you work, before any AI change, and each time you publish. '
            'Come back here to see or restore one.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.onSurfaceVariant,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _VersionPreview extends StatelessWidget {
  const _VersionPreview({
    required this.summary,
    required this.version,
    required this.onBack,
    super.key,
  });

  final ManuscriptVersionSummary summary;
  final Future<ManuscriptVersion> version;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: AppButton.text(
            label: 'All versions',
            leading: const Icon(Icons.arrow_back),
            onPressed: onBack,
          ),
        ),
        const SizedBox(height: AppSpacing.xxs),
        Text(
          versionTimeLabel(context, summary.createdAt),
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          '${summary.reason.label} · '
          '${_wordsLabel(context, summary.wordCount)}',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        FutureBuilder<ManuscriptVersion>(
          future: version,
          builder: (context, snapshot) {
            if (snapshot.hasError) {
              return AppInlineNotice(
                tone: AppTone.error,
                title: 'Could not open this version',
                message: userFacingError(snapshot.error!),
              );
            }
            final loaded = snapshot.data;
            return AnimatedSwitcher(
              duration: AppMotion.adapt(context, AppMotion.medium),
              child: loaded == null
                  ? const AppSkeletonGroup(
                      key: ValueKey('version-text-loading'),
                      label: 'Opening version',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppSkeleton.line(widthFactor: 0.5, height: 18),
                          SizedBox(height: AppSpacing.md),
                          AppSkeleton.line(widthFactor: 1),
                          SizedBox(height: 8),
                          AppSkeleton.line(widthFactor: 0.95),
                          SizedBox(height: 8),
                          AppSkeleton.line(widthFactor: 0.8),
                        ],
                      ),
                    )
                  : _VersionText(
                      key: const ValueKey('version-text'),
                      version: loaded,
                    ),
            );
          },
        ),
      ],
    );
  }
}

/// The version as it reads, not as it is typed: headings, bold and italic
/// drawn; a picture named in place of its markdown; a picture-book page break
/// shown as a break.
class _VersionText extends StatelessWidget {
  const _VersionText({required this.version, super.key});

  final ManuscriptVersion version;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final body = versionPreviewMarkdown(version.markdown);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (version.title.trim().isNotEmpty) ...[
              Text(
                version.title.trim(),
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
            if (body.trim().isEmpty)
              Text(
                'This version was empty.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                  fontStyle: FontStyle.italic,
                ),
              )
            else
              ChatMessageText(
                body,
                style: theme.textTheme.bodyLarge?.copyWith(height: 1.55),
              ),
          ],
        ),
      ),
    );
  }
}

final _imageLine = RegExp(r'^\s*!\[([^\]]*)\]\([^)]*\)\s*$');
final _pageSeparator = RegExp(r'^\s*<!--\s*page\s*-->\s*$');

/// The markdown a preview draws: image lines named, page separators shown as
/// a break. Everything else is left for the light markdown renderer.
@visibleForTesting
String versionPreviewMarkdown(String markdown) {
  final lines = markdown.replaceAll('\r\n', '\n').split('\n');
  return [
    for (final line in lines)
      if (_pageSeparator.hasMatch(line))
        '· · ·'
      else if (_imageLine.firstMatch(line) case final match?)
        match.group(1)!.trim().isEmpty
            ? '*[Picture]*'
            : '*[Picture: ${match.group(1)!.trim()}]*'
      else
        line,
  ].join('\n');
}
