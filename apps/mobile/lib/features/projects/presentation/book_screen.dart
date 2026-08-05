import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../reader/data/reader_repository.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'book_preview_section.dart';
import 'book_screen_body.dart';
import 'plan_approval.dart';
import 'plan_revision_retry.dart';
import 'project_export_actions.dart';
import 'project_route_error.dart';

/// One book, one page.
///
/// This used to be two: a plan screen you landed on from the shelf, and a
/// progress screen you had to find a button to reach. A book being written
/// opened on the plan — the part that was already decided — and the writing it
/// was actually doing was one tap further away. Both are here now, and
/// [BookScreenBody] shows whichever of them is true.
class BookScreen extends ConsumerStatefulWidget {
  const BookScreen({required this.projectId, this.initialMessage, super.key});

  final String projectId;

  /// What the caller just asked for ("Importing your book…"), shown until the
  /// server's own status catches up with it.
  final String? initialMessage;

  @override
  ConsumerState<BookScreen> createState() => _BookScreenState();
}

class _BookScreenState extends ConsumerState<BookScreen> {
  final _revisionController = TextEditingController();
  Timer? _pollTimer;
  String? _busyAction;
  bool _celebrated = false;
  bool _notifiedFailure = false;
  String? _revisionRequestId;
  String? _revisionRequestText;
  ProviderSubscription<AsyncValue<MobileProjectStatus>>? _statusSubscription;

  @override
  void initState() {
    super.initState();
    // The detail fetch (plan, pages, cover) is only worth re-running while the
    // book is actively being worked on. The timer follows the live status and
    // stops once the project settles — and restarts if a retry brings it back.
    _statusSubscription = ref.listenManual(
      projectStatusProvider(widget.projectId),
      (previous, next) => _syncDetailPolling(next),
      fireImmediately: true,
    );
  }

  @override
  void dispose() {
    _statusSubscription?.close();
    _pollTimer?.cancel();
    _revisionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final statusValue = ref.watch(projectStatusProvider(widget.projectId));
    final projectValue = ref.watch(projectDetailProvider(widget.projectId));
    final billingValue = ref.watch(billingProvider);
    final chatValue = ref.watch(projectChatProvider(widget.projectId));

    // `value`, not `asData`: both of these are re-fetched on a timer, and the
    // page must keep showing what it has while the next one is in flight —
    // `asData` is null for the whole of a refresh.
    final project = projectValue.value;
    final status = statusValue.value;

    MobileBookEditOperation? failedRevision;
    for (final operation in chatValue.value?.operations ?? const []) {
      if (operation.isPlanRevision && operation.isFailed) {
        failedRevision = operation;
        break;
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(project?.title ?? 'Your book'),
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
      body: _body(
        projectValue: projectValue,
        project: project,
        status: status,
        billing: billingValue.value,
        failedRevision: failedRevision,
      ),
    );
  }

  Widget _body({
    required AsyncValue<MobileProjectDetail> projectValue,
    required MobileProjectDetail? project,
    required MobileProjectStatus? status,
    required MobileBilling? billing,
    required MobileBookEditOperation? failedRevision,
  }) {
    // A book that cannot be loaded has no page to draw, whatever the status
    // stream still says about it.
    if (project == null && projectValue.hasError) {
      return ProjectRouteErrorState(
        error: projectValue.error!,
        fallbackTitle: 'Book unavailable',
        onRetry: _refresh,
        onGoHome: () => context.go('/home'),
      );
    }
    if (project == null && status == null) {
      return const AppLoadingState(message: 'Opening your book');
    }

    return BookScreenBody(
      status: status,
      project: project,
      billing: billing,
      initialMessage: widget.initialMessage,
      busyAction: _busyAction,
      revisionController: _revisionController,
      failedRevision: failedRevision,
      onRefresh: () async => _refresh(),
      onResume: (status?.retryAvailable ?? false) ? _resumeGeneration : null,
      onGeneratePlan: _generatePlan,
      onRevisePlan: project == null ? null : (m) => _revisePlan(project, m),
      onApprovePlan: project?.plan == null
          ? null
          : () => _confirmAndApprove(project!),
      onRetryRevision: failedRevision == null
          ? null
          : () => _retryRevision(failedRevision),
      onEditFailedRequest: failedRevision?.submittedText == null
          ? null
          : () => _restoreFailedRevision(failedRevision!),
      onDeleteProject: project == null
          ? null
          : () => _confirmAndDelete(project),
      onOpen: _exportAndOpen,
      onDownload: _exportAndDownload,
      onOpenPaywall: _openExportPaywall,
      onReportProject: _reportProject,
      onReportImage: _reportImage,
    );
  }

  /// Announce the finish once per visit, the first time the poll reports a
  /// completed book. Guarded so a later refresh does not re-celebrate.
  void _announceCompletion(AsyncValue<MobileProjectStatus> statusValue) {
    final status = statusValue.value;
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
    final live = statusValue.value?.isLive ?? false;
    if (live) {
      _pollTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
        _refreshDetails();
      });
    } else if (_pollTimer != null) {
      _pollTimer?.cancel();
      _pollTimer = null;
      // One last refresh so the page reflects the finished book.
      _refreshDetails();
    }
  }

  void _refresh() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    _refreshDetails();
  }

  void _refreshDetails() {
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  /// Reopens the status stream after queueing work.
  ///
  /// The stream closes itself the moment a project stops being live, so a book
  /// sitting at `draft` has no open connection to notice that planning just
  /// started. Without this the page would wait for a manual refresh.
  void _watchNewWork() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    ref.invalidate(projectsProvider);
    _refreshDetails();
  }

  Future<void> _generatePlan() async {
    await _runPlanAction(
      action: 'plan',
      future: () =>
          ref.read(projectsRepositoryProvider).generatePlan(widget.projectId),
    );
  }

  void _restoreFailedRevision(MobileBookEditOperation operation) {
    final text = operation.submittedText?.trim();
    if (text == null || text.isEmpty) return;
    setState(() {
      _revisionController.text = text;
      _revisionController.selection = TextSelection.collapsed(
        offset: text.length,
      );
    });
  }

  Future<void> _retryRevision(MobileBookEditOperation operation) async {
    if (operation.isAutomaticRetryPending) {
      _watchNewWork();
      return;
    }
    if (!operation.retryAvailable) {
      _restoreFailedRevision(operation);
      return;
    }
    await _runPlanAction(
      action: 'retry-revision',
      future: () => ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: operation.projectId,
            operationId: operation.id,
            requestId: createPlanRevisionRetryRequestId(operation.id),
          )
          .then(
            (operation) => MobilePlanOperation(
              projectId: operation.projectId,
              planId: null,
              status: operation.status,
              currentAction: operation.displayAction,
              job:
                  operation.job ??
                  MobileQueuedJob(
                    id: operation.id,
                    status: operation.status,
                    currentAction: operation.displayAction,
                  ),
            ),
          ),
    );
    ref.invalidate(projectChatProvider(widget.projectId));
  }

  Future<void> _revisePlan(MobileProjectDetail project, String message) async {
    final plan = project.plan;
    if (plan == null) {
      return;
    }
    final trimmed = message.trim();
    if (_revisionRequestText != trimmed) {
      _revisionRequestText = trimmed;
      _revisionRequestId = 'revision-${DateTime.now().microsecondsSinceEpoch}';
    }
    await _runPlanAction(
      action: 'revise',
      future: () => ref
          .read(projectsRepositoryProvider)
          .revisePlan(
            planId: plan.id,
            message: trimmed,
            requestId: _revisionRequestId,
          ),
      clearRevisionText: true,
      onSuccess: () {
        _revisionRequestText = null;
        _revisionRequestId = null;
      },
    );
  }

  Future<void> _runPlanAction({
    required String action,
    required Future<MobilePlanOperation> Function() future,
    bool clearRevisionText = false,
    VoidCallback? onSuccess,
  }) async {
    setState(() => _busyAction = action);
    try {
      final operation = await future();
      if (!mounted) {
        return;
      }
      setState(() {
        _busyAction = null;
        if (clearRevisionText) {
          _revisionController.clear();
        }
      });
      onSuccess?.call();
      _watchNewWork();
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(operation.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _confirmAndApprove(MobileProjectDetail project) async {
    final operation = await confirmAndApprovePlan(
      context,
      ref,
      project,
      onStart: () {
        if (mounted) {
          setState(() => _busyAction = 'approve');
        }
      },
      onSettled: () {
        if (mounted && _busyAction == 'approve') {
          setState(() => _busyAction = null);
        }
      },
    );
    if (operation == null || !mounted) {
      return;
    }
    // No navigation: approving is the moment this page changes from a plan to
    // a book being written, and it does that in place.
    _watchNewWork();
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(operation.currentAction)));
  }

  Future<void> _resumeGeneration() async {
    setState(() => _busyAction = 'resume');
    try {
      final recovery = await ref
          .read(projectsRepositoryProvider)
          .resumeProject(widget.projectId);
      _watchNewWork();
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(recovery.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _confirmAndDelete(MobileProjectDetail project) async {
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete this project?',
      message:
          'This removes "${project.title}" and its generated files from your account. Some safety, billing, and support records may be retained.',
      confirmLabel: 'Delete project',
      destructive: true,
    );
    if (!confirmed || !mounted) {
      return;
    }

    setState(() => _busyAction = 'delete');
    try {
      await ref.read(projectsRepositoryProvider).deleteProject(project.id);
      // The reader keeps the downloaded PDF, the reading position and the
      // reader's own markup on the device. Deleting the book on the server and
      // leaving all of that behind would be the one part of "removes its
      // generated files" that was not true — and markup is the part they wrote.
      await ref.read(readerRepositoryProvider).clearProject(project.id);
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(project.id));
      if (!mounted) {
        return;
      }
      context.go('/home');
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text('Deleted ${project.title}.')));
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
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
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(content: Text('Report sent for review.')),
      );
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() => _busyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }
}
