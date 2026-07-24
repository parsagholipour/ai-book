import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/config/app_config.dart';
import '../../../app/theme/app_theme.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'project_route_error.dart';
import 'project_export_actions.dart';

class GenerationProgressScreen extends ConsumerStatefulWidget {
  const GenerationProgressScreen({
    required this.projectId,
    this.initialMessage,
    super.key,
  });

  final String projectId;
  final String? initialMessage;

  @override
  ConsumerState<GenerationProgressScreen> createState() =>
      _GenerationProgressScreenState();
}

class _GenerationProgressScreenState
    extends ConsumerState<GenerationProgressScreen> {
  Timer? _pollTimer;
  String? _busyAction;
  bool _celebrated = false;
  bool _notifiedFailure = false;
  ProviderSubscription<AsyncValue<MobileProjectStatus>>? _statusSubscription;

  @override
  void initState() {
    super.initState();
    // Page previews are only worth re-fetching while the book is actively
    // being worked on; the timer follows the live status and stops once the
    // project settles (and restarts if a resume brings it back to life).
    _statusSubscription = ref.listenManual(
      projectStatusProvider(widget.projectId),
      (previous, next) => _syncDetailPolling(next),
      fireImmediately: true,
    );
  }

  /// Announce the finish once per visit, the first time the poll reports a
  /// completed book. Guarded so a later refresh does not re-celebrate.
  void _announceCompletion(AsyncValue<MobileProjectStatus> statusValue) {
    final status = statusValue.asData?.value;
    if (status == null || _celebrated) {
      return;
    }
    if (status.isComplete && status.hasReadyExport) {
      _celebrated = true;
      AppHaptics.success();
    } else if (status.status == 'failed' && !_notifiedFailure) {
      _notifiedFailure = true;
      AppHaptics.error();
    }
  }

  void _syncDetailPolling(AsyncValue<MobileProjectStatus> statusValue) {
    _announceCompletion(statusValue);
    final live = statusValue.asData?.value.isLive ?? false;
    if (live) {
      _pollTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
        _refreshDetails();
      });
    } else if (_pollTimer != null) {
      _pollTimer?.cancel();
      _pollTimer = null;
      // One last refresh so the previews reflect the finished book.
      _refreshDetails();
    }
  }

  @override
  void dispose() {
    _statusSubscription?.close();
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final statusValue = ref.watch(projectStatusProvider(widget.projectId));
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));
    final billingValue = ref.watch(billingProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book progress'),
        actions: [
          IconButton(
            tooltip: 'Book chat',
            onPressed: () => context.push('/projects/${widget.projectId}/chat'),
            icon: const Icon(Icons.chat_bubble_outline),
          ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: statusValue.when(
        data: (status) => ProjectGenerationView(
          status: status,
          project: projectValue.asData?.value,
          billing: billingValue.asData?.value,
          initialMessage: widget.initialMessage,
          busyAction: _busyAction,
          onRefresh: () async => _refresh(),
          onResume: status.retryAvailable ? _resumeGeneration : null,
          onOpen: _exportAndOpen,
          onDownload: _exportAndDownload,
          onOpenPaywall: _openExportPaywall,
          onReportProject: _reportProject,
          onReportImage: _reportImage,
        ),
        loading: () => const AppLoadingState(message: 'Checking book progress'),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Progress unavailable',
          onRetry: _refresh,
          onGoHome: () => context.go('/home'),
        ),
      ),
    );
  }

  void _refresh() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    _refreshDetails();
  }

  void _refreshDetails() {
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  Future<void> _resumeGeneration() async {
    setState(() => _busyAction = 'resume');
    try {
      final recovery = await ref
          .read(projectsRepositoryProvider)
          .resumeProject(widget.projectId);
      _refresh();
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(recovery.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _exportAndOpen(MobileExportAvailability export) async {
    setState(() => _busyAction = projectExportDownloadAction(export));
    await openProjectExport(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refresh,
    );
    if (!mounted) {
      return;
    }
    setState(() => _busyAction = null);
  }

  Future<void> _exportAndDownload(MobileExportAvailability export) async {
    setState(() => _busyAction = projectExportSaveAction(export));
    await downloadProjectExport(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refresh,
    );
    if (!mounted) {
      return;
    }
    setState(() => _busyAction = null);
  }

  Future<void> _openExportPaywall(MobileExportAvailability export) async {
    await openProjectExportPaywall(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refresh,
    );
  }

  Future<void> _reportProject() async {
    await _showReportDialog(
      title: 'Report this AI-generated book',
      submit: (reason, comment) => ref
          .read(projectsRepositoryProvider)
          .reportProject(
            projectId: widget.projectId,
            reason: reason,
            comment: comment,
          ),
    );
  }

  Future<void> _reportImage(MobileProjectImage image) async {
    await _showReportDialog(
      title: 'Report this AI-generated visual',
      submit: (reason, comment) => ref
          .read(projectsRepositoryProvider)
          .reportAsset(
            projectId: widget.projectId,
            assetId: image.id,
            reason: reason,
            comment: comment,
          ),
    );
  }

  Future<void> _showReportDialog({
    required String title,
    required Future<ModerationReportReceipt> Function(
      String reason,
      String? comment,
    )
    submit,
  }) async {
    final request = await showDialog<ContentReportRequest>(
      context: context,
      builder: (context) => ContentReportDialog(title: title),
    );
    if (request == null || !mounted) {
      return;
    }

    setState(() => _busyAction = 'report');
    try {
      await submit(request.reason, request.comment);
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Report sent for review.')));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}

class ProjectGenerationView extends StatelessWidget {
  const ProjectGenerationView({
    required this.status,
    required this.onRefresh,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.project,
    this.billing,
    this.initialMessage,
    this.busyAction,
    this.onResume,
    this.onReportProject,
    this.onReportImage,
    super.key,
  });

  final MobileProjectStatus status;
  final MobileProjectDetail? project;
  final MobileBilling? billing;
  final String? initialMessage;
  final String? busyAction;
  final Future<void> Function() onRefresh;
  final Future<void> Function()? onResume;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;
  final Future<void> Function()? onReportProject;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
        children: [
          // Once the book is finished, the finished book leads — the progress
          // breakdown becomes reference material rather than the headline.
          if (status.isComplete && status.hasReadyExport) ...[
            _BookReadyCard(status: status, project: project),
            const SizedBox(height: 12),
          ] else ...[
            _ProgressOverviewCard(
              status: status,
              initialMessage: initialMessage,
              busyAction: busyAction,
              onResume: onResume,
            ),
            const SizedBox(height: 12),
          ],
          if (status.quality.isBlocked || status.quality.recommendsReview) ...[
            _QualityGateCard(
              quality: status.quality,
              onOpenPage: (pageIndex) => context.push(
                '/projects/${status.projectId}/edit?pageIndex=$pageIndex',
              ),
              onRequestRegeneration: () =>
                  context.push('/projects/${status.projectId}/chat'),
            ),
            const SizedBox(height: 12),
          ],
          if (project != null) ...[
            GeneratedBookPreview(
              project: project!,
              onReportProject: onReportProject,
              onReportImage: onReportImage,
            ),
            const SizedBox(height: 12),
          ],
          if (!status.quality.isBlocked)
            ProjectExportPanel(
              exports: status.exports,
              billing: billing,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
              editBookProjectId: status.isComplete ? status.projectId : null,
            ),
        ],
      ),
    );
  }
}

/// The payoff: shown in place of the progress breakdown once the book exists.
///
/// Finishing a book is the moment the whole product is for, and before this it
/// was marked only by a progress bar quietly reaching 100%. Showing the cover
/// the user just made, at size, is the reward.
class _BookReadyCard extends StatelessWidget {
  const _BookReadyCard({required this.status, this.project});

  final MobileProjectStatus status;
  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final title = project?.title ?? 'Your book';
    final pages = status.pageProgress.completed;

    return AppEntrance(
      offset: 16,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              colors.primary,
              Color.lerp(colors.primary, colors.tertiary, 0.55)!,
            ],
          ),
          borderRadius: BorderRadius.circular(TomezaRadii.card),
        ),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              BookCover(
                title: title,
                seed: status.projectId,
                image: project?.coverImage,
                authorName: project?.authorName,
                width: 84,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Your book is ready',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: colors.onPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: colors.onPrimary.withValues(alpha: 0.92),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      pages > 0
                          ? '$pages pages written. Download or share it below.'
                          : 'Download or share it below.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onPrimary.withValues(alpha: 0.85),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QualityGateCard extends StatelessWidget {
  const _QualityGateCard({
    required this.quality,
    required this.onOpenPage,
    required this.onRequestRegeneration,
  });

  final MobileProjectQuality quality;
  final void Function(int pageIndex) onOpenPage;
  final VoidCallback onRequestRegeneration;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final blocked = quality.isBlocked;
    return Card(
      color: blocked ? colors.errorContainer : colors.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  blocked ? Icons.gpp_bad_outlined : Icons.rate_review_outlined,
                  color: blocked
                      ? colors.onErrorContainer
                      : colors.onTertiaryContainer,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    blocked
                        ? 'Export blocked by quality checks'
                        : 'Review recommended',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              blocked
                  ? 'Fix the deterministic integrity issues below, then save to rerun the checks.'
                  : 'The book is exportable, but these prose concerns may be worth reviewing.',
            ),
            const SizedBox(height: 12),
            for (final issue in quality.issues.take(8))
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: issue.affectedPageIndexes.isEmpty
                      ? null
                      : () => onOpenPage(issue.affectedPageIndexes.first),
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          issue.message,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 3),
                        Text(issue.guidance),
                        if (issue.affectedPageIndexes.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            'Pages ${issue.affectedPageIndexes.join(', ')} · Open Edit Mode',
                            style: TextStyle(
                              color: colors.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (quality.affectedPageIndexes.isNotEmpty)
                  FilledButton.tonalIcon(
                    onPressed: () =>
                        onOpenPage(quality.affectedPageIndexes.first),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Open Edit Mode'),
                  ),
                OutlinedButton.icon(
                  onPressed: onRequestRegeneration,
                  icon: const Icon(Icons.auto_fix_high_outlined),
                  label: const Text('Request regeneration'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ProgressOverviewCard extends StatelessWidget {
  const _ProgressOverviewCard({
    required this.status,
    required this.busyAction,
    this.initialMessage,
    this.onResume,
  });

  final MobileProjectStatus status;
  final String? initialMessage;
  final String? busyAction;
  final Future<void> Function()? onResume;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final progress = status.progressPercent.clamp(0, 100).toInt();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              status.statusLabel,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              status.effectiveAction,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
            ),
            if (initialMessage != null &&
                initialMessage != status.currentAction) ...[
              const SizedBox(height: 4),
              Text(
                initialMessage!,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: AppAnimatedProgressBar(
                    value: progress / 100,
                    semanticLabel: 'Book generation progress',
                  ),
                ),
                const SizedBox(width: 12),
                AppAnimatedCount(
                  value: progress,
                  builder: (value) => '$value%',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ],
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                AppMetricChip(
                  icon: Icons.menu_book_outlined,
                  label:
                      '${status.pageProgress.completed}/${status.pageProgress.target} pages',
                ),
                AppMetricChip(
                  icon: Icons.image_outlined,
                  label: '${status.imageCount} visuals',
                ),
              ],
            ),
            const SizedBox(height: 16),
            for (final step in status.steps) _ProgressStepTile(step: step),
            if (status.isAutomaticRetryPending) ...[
              const SizedBox(height: 12),
              AppInlineNotice(
                icon: Icons.autorenew_outlined,
                title: 'Retry scheduled',
                message: status.retryMessage?.trim().isNotEmpty == true
                    ? status.retryMessage!
                    : 'Writing will continue automatically. You can leave this screen.',
                tone: AppNoticeTone.info,
              ),
            ] else if (status.hasFailure || status.status == 'failed') ...[
              const SizedBox(height: 12),
              AppInlineNotice(
                icon: Icons.error_outline,
                title: status.retryAvailable
                    ? 'Writing needs a retry'
                    : 'Writing needs attention',
                message: status.failureMessage?.trim().isNotEmpty == true
                    ? status.failureMessage!
                    : status.effectiveAction,
                tone: AppNoticeTone.error,
              ),
              if (onResume != null) ...[
                const SizedBox(height: 10),
                FilledButton.icon(
                  onPressed: busyAction == 'resume' ? null : () => onResume!(),
                  icon: busyAction == 'resume'
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            semanticsLabel: 'Retrying generation',
                          ),
                        )
                      : const Icon(Icons.replay_outlined),
                  label: const Text('Retry generation'),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _ProgressStepTile extends StatelessWidget {
  const _ProgressStepTile({required this.step});

  final MobileProjectStatusStep step;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final icon = step.isDone
        ? Icons.check_circle
        : step.isFailed
        ? Icons.error
        : step.isActive
        ? Icons.radio_button_checked
        : Icons.radio_button_unchecked;
    final color = step.isDone
        ? colors.primary
        : step.isFailed
        ? colors.error
        : step.isActive
        ? colors.tertiary
        : colors.onSurfaceVariant;
    final stateLabel = step.isDone
        ? 'Done'
        : step.isFailed
        ? 'Needs attention'
        : step.isActive
        ? 'In progress'
        : 'Waiting';
    final semanticLabel = [
      step.label,
      stateLabel,
      if (step.detail != null) step.detail!,
    ].join('. ');
    return Semantics(
      container: true,
      label: semanticLabel,
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      step.label,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (step.detail != null)
                      Text(
                        step.detail!,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class GeneratedBookPreview extends StatelessWidget {
  const GeneratedBookPreview({
    required this.project,
    this.onReportProject,
    this.onReportImage,
    super.key,
  });

  final MobileProjectDetail project;
  final Future<void> Function()? onReportProject;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    final pages = project.pages
        .where(
          (page) =>
              page.previewText.trim().isNotEmpty || page.summary.isNotEmpty,
        )
        .toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Book preview',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'AI-generated content from your prompt and selected preset.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            if (onReportProject != null) ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: () => onReportProject!(),
                icon: const Icon(Icons.flag_outlined),
                label: const Text('Report book'),
              ),
            ],
            const SizedBox(height: 12),
            if (project.coverImage != null) ...[
              _AuthenticatedProjectImage(image: project.coverImage!),
              if (onReportImage != null) ...[
                const SizedBox(height: 8),
                _ReportVisualButton(
                  onPressed: () => onReportImage!(project.coverImage!),
                ),
              ],
              const SizedBox(height: 12),
            ],
            if (pages.isEmpty)
              Text(
                'Generated pages will appear here as soon as writing starts.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              )
            else
              for (final page in pages) ...[
                _GeneratedPagePreview(page: page, onReportImage: onReportImage),
                if (page != pages.last) const Divider(height: 22),
              ],
          ],
        ),
      ),
    );
  }
}

class _GeneratedPagePreview extends StatelessWidget {
  const _GeneratedPagePreview({required this.page, this.onReportImage});

  final MobileProjectPage page;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final preview = page.previewText.trim().isNotEmpty
        ? page.previewText
        : page.summary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              'Page ${page.index}',
              style: Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: colors.primary),
            ),
            Text(
              page.title,
              style: Theme.of(
                context,
              ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        if (page.image != null) ...[
          const SizedBox(height: 10),
          _AuthenticatedProjectImage(image: page.image!),
          if (onReportImage != null) ...[
            const SizedBox(height: 8),
            _ReportVisualButton(onPressed: () => onReportImage!(page.image!)),
          ],
        ],
        const SizedBox(height: 8),
        Text(preview, maxLines: 8, overflow: TextOverflow.ellipsis),
      ],
    );
  }
}

class _AuthenticatedProjectImage extends ConsumerWidget {
  const _AuthenticatedProjectImage({required this.image});

  final MobileProjectImage image;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(image.url).toString();
    return AspectRatio(
      aspectRatio: image.role == 'cover' ? 3 / 4 : 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: headersValue.when(
          data: (headers) => Image.network(
            uri,
            headers: headers,
            fit: BoxFit.cover,
            semanticLabel: image.altText,
            errorBuilder: (context, error, stackTrace) =>
                _ImageUnavailable(label: image.altText),
          ),
          loading: () => _ImageLoading(label: image.altText),
          error: (error, stackTrace) => _ImageUnavailable(label: image.altText),
        ),
      ),
    );
  }
}

class _ImageLoading extends StatelessWidget {
  const _ImageLoading({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: CircularProgressIndicator(
          semanticsLabel: label.isEmpty
              ? 'Loading generated visual'
              : 'Loading $label',
        ),
      ),
    );
  }
}

class _ImageUnavailable extends StatelessWidget {
  const _ImageUnavailable({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final message = label.isEmpty
        ? 'Generated visual unavailable'
        : '$label unavailable';
    return Semantics(
      label: message,
      child: ExcludeSemantics(
        child: ColoredBox(
          color: colors.surfaceContainerHighest,
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.image_not_supported_outlined,
                    color: colors.outline,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ReportVisualButton extends StatelessWidget {
  const _ReportVisualButton({required this.onPressed});

  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton.icon(
        onPressed: () => onPressed(),
        icon: const Icon(Icons.flag_outlined),
        label: const Text('Report visual'),
      ),
    );
  }
}

class ContentReportRequest {
  const ContentReportRequest({required this.reason, this.comment});

  final String reason;
  final String? comment;
}

class ContentReportDialog extends StatefulWidget {
  const ContentReportDialog({required this.title, super.key});

  final String title;

  @override
  State<ContentReportDialog> createState() => _ContentReportDialogState();
}

class _ContentReportDialogState extends State<ContentReportDialog> {
  final _commentController = TextEditingController();
  String _reason = 'other';

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DropdownButtonFormField<String>(
            initialValue: _reason,
            decoration: const InputDecoration(labelText: 'Reason'),
            items: const [
              DropdownMenuItem(value: 'offensive', child: Text('Offensive')),
              DropdownMenuItem(
                value: 'hate_or_harassment',
                child: Text('Hate or harassment'),
              ),
              DropdownMenuItem(
                value: 'sexual_content',
                child: Text('Sexual content'),
              ),
              DropdownMenuItem(
                value: 'violence_or_self_harm',
                child: Text('Violence or self-harm'),
              ),
              DropdownMenuItem(
                value: 'child_safety',
                child: Text('Child safety concern'),
              ),
              DropdownMenuItem(
                value: 'deceptive_or_misleading',
                child: Text('Misleading or inaccurate'),
              ),
              DropdownMenuItem(
                value: 'privacy_or_copyright',
                child: Text('Privacy or copyright'),
              ),
              DropdownMenuItem(value: 'other', child: Text('Other')),
            ],
            onChanged: (value) => setState(() => _reason = value ?? 'other'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _commentController,
            decoration: const InputDecoration(
              labelText: 'Optional details',
              hintText: 'Briefly describe the issue',
            ),
            minLines: 3,
            maxLines: 5,
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(
            ContentReportRequest(
              reason: _reason,
              comment: _commentController.text.trim().isEmpty
                  ? null
                  : _commentController.text.trim(),
            ),
          ),
          child: const Text('Send report'),
        ),
      ],
    );
  }
}

class ProjectExportPanel extends StatelessWidget {
  const ProjectExportPanel({
    required this.exports,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
    this.billing,
    this.busyAction,
    this.editBookProjectId,
    super.key,
  });

  final MobileExportSet exports;
  final MobileBilling? billing;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  /// When set, shows the manual Edit Mode entry for this completed book.
  final String? editBookProjectId;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Exports',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              'Exports stay protected by your account and project unlock.',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            _ExportFormatTile(
              export: exports.pdf,
              availableCredits: billing?.credits.available,
              icon: Icons.picture_as_pdf_outlined,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
            ),
            const Divider(height: 22),
            _ExportFormatTile(
              export: exports.epub,
              availableCredits: billing?.credits.available,
              icon: Icons.menu_book_outlined,
              busyAction: busyAction,
              onOpen: onOpen,
              onDownload: onDownload,
              onOpenPaywall: onOpenPaywall,
            ),
            if (editBookProjectId != null) ...[
              const Divider(height: 22),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Want to change something yourself? Open Edit Mode and '
                      'rewrite any page before you export.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  OutlinedButton.icon(
                    onPressed: () =>
                        context.push('/projects/$editBookProjectId/edit'),
                    icon: const Icon(Icons.edit_note_outlined),
                    label: const Text('Edit book'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ExportFormatTile extends StatelessWidget {
  const _ExportFormatTile({
    required this.export,
    required this.availableCredits,
    required this.icon,
    required this.busyAction,
    required this.onOpen,
    required this.onDownload,
    required this.onOpenPaywall,
  });

  final MobileExportAvailability export;
  final int? availableCredits;
  final IconData icon;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onOpen;
  final Future<void> Function(MobileExportAvailability export) onDownload;
  final Future<void> Function(MobileExportAvailability export) onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final openAction = projectExportDownloadAction(export);
    final saveAction = projectExportSaveAction(export);
    final isOpening = busyAction == openAction;
    final isDownloading = busyAction == saveAction;
    final isBusy = isOpening || isDownloading;
    final needsCredits = projectExportNeedsCredits(export, availableCredits);
    final canAct = export.available && !isBusy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: colors.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    export.format.toUpperCase(),
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    projectExportStateText(export, availableCredits),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: canAct
                  ? () => needsCredits ? onOpenPaywall(export) : onOpen(export)
                  : null,
              icon: isOpening
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'Opening export',
                      ),
                    )
                  : Icon(
                      export.unlocked
                          ? Icons.open_in_new_outlined
                          : needsCredits
                          ? Icons.add_card_outlined
                          : Icons.lock_open_outlined,
                    ),
              label: Text(projectExportDownloadLabel(export, needsCredits)),
            ),
            if (export.unlocked)
              OutlinedButton.icon(
                onPressed: canAct ? () => onDownload(export) : null,
                icon: isDownloading
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          semanticsLabel: 'Downloading export',
                        ),
                      )
                    : const Icon(Icons.download_outlined),
                label: const Text('Download'),
              ),
          ],
        ),
      ],
    );
  }
}
