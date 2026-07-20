import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import 'chat_history_drawer.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/easy_drawer_open.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/creation_repository.dart';
import '../data/projects_repository.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'chat_media_preview.dart';
import 'creation_chat_controller.dart';
import 'creation_labels.dart';
import 'message_actions_menu.dart';
import 'plan_approval.dart';
import 'project_export_actions.dart';
import 'saved_export_card.dart';

class CreationChatScreen extends ConsumerStatefulWidget {
  const CreationChatScreen({super.key, this.startFresh = false, this.draftId});

  final bool startFresh;
  final String? draftId;

  @override
  ConsumerState<CreationChatScreen> createState() => _CreationChatScreenState();
}

class _CreationChatScreenState extends ConsumerState<CreationChatScreen> {
  final _composerController = TextEditingController();
  final _revisionController = TextEditingController();
  final _scrollController = ScrollController();
  final _drawerKey = GlobalKey<EasyDrawerControllerState>();

  String? _projectId;
  String? _planBusyAction;
  String? _activePlanKey;
  String? _pendingRevisionPlanKey;
  String? _pendingRevisionOperationId;
  Timer? _planRefreshTimer;
  Timer? _stickScrollTimer;
  Object? _lastScrollTrigger;
  bool _stickToBottom = true;
  bool _projectChatSending = false;
  bool _projectChatBranchSwitching = false;
  String? _editingProjectMessageId;
  String? _editingCreationMessageId;
  String? _pendingProjectRequestId;
  String? _pendingProjectRequestText;
  String? _pendingProjectEditMessageId;
  final Set<String> _requestedReplanCopyOutputSyncs = <String>{};

  // Plan question tracking
  int _planQuestionIndex = 0;
  Map<int, String> _planQuestionAnswers = {};

  @override
  void initState() {
    super.initState();
    _initConversation();
  }

  @override
  void didUpdateWidget(covariant CreationChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.startFresh == widget.startFresh &&
        oldWidget.draftId == widget.draftId) {
      return;
    }
    _resetLocalConversationState();
    _initConversation(force: true);
  }

  @override
  void dispose() {
    _planRefreshTimer?.cancel();
    _stickScrollTimer?.cancel();
    _composerController.dispose();
    _revisionController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _initConversation({bool force = false}) {
    unawaited(
      Future<void>.microtask(() async {
        if (!mounted) return;
        final controller = ref.read(creationChatControllerProvider.notifier);
        await controller.init(
          fresh: widget.startFresh,
          draftId: widget.draftId,
          force: force,
        );
      }),
    );
  }

  void _resetLocalConversationState() {
    _planRefreshTimer?.cancel();
    _planRefreshTimer = null;
    _composerController.clear();
    _revisionController.clear();
    _projectId = null;
    _planBusyAction = null;
    _activePlanKey = null;
    _pendingRevisionPlanKey = null;
    _planQuestionIndex = 0;
    _planQuestionAnswers = {};
    _lastScrollTrigger = null;
    _stickToBottom = true;
    _stickScrollTimer?.cancel();
    _stickScrollTimer = null;
    _projectChatSending = false;
    _projectChatBranchSwitching = false;
    _editingProjectMessageId = null;
    _editingCreationMessageId = null;
    _requestedReplanCopyOutputSyncs.clear();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<CreationChatState>(creationChatControllerProvider, (_, next) {
      final error = next.initError;
      if (error == null) return;
      // Full-screen recovery handles empty-chat init failures.
      if (next.messages.isEmpty && !next.initializing) return;
      // Failed bubbles already show the send error; avoid a duplicate snackbar.
      if (next.messages.any((message) => message.isFailedSend)) {
        ref.read(creationChatControllerProvider.notifier).clearError();
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error)));
      ref.read(creationChatControllerProvider.notifier).clearError();
    });
    // "Ok, build it" from chat starts the same preflight/build flow as the
    // Build button.
    ref.listen<bool>(
      creationChatControllerProvider.select((s) => s.pendingBuildRequest),
      (previous, next) {
        if (next && previous != true) {
          ref.read(creationChatControllerProvider.notifier).clearBuildRequest();
          unawaited(_build());
        }
      },
    );

    final state = ref.watch(creationChatControllerProvider);
    final activeProjectId = _activeProjectId(state);
    final isInOutputStage = activeProjectId != null;
    final activeDraftId = widget.draftId ?? state.draftId;
    final loadingSelectedChat =
        widget.draftId != null && widget.draftId != state.draftId;
    final sidebarTitle = ref
        .watch(chatSessionsProvider)
        .maybeWhen(
          data: (sessions) => _titleForDraft(sessions, activeDraftId),
          orElse: () => null,
        );
    final screenTitle = _screenTitle(
      state,
      sidebarTitle,
      preferSidebarTitle: loadingSelectedChat,
    );

    AsyncValue<MobileProjectDetail>? planValue;
    AsyncValue<MobileProjectChat>? projectChatValue;
    AsyncValue<MobileProjectStatus>? generationStatusValue;
    if (isInOutputStage) {
      planValue = ref.watch(projectDetailProvider(activeProjectId));
      projectChatValue = ref.watch(projectChatProvider(activeProjectId));
      final project = planValue?.asData?.value;
      if (_shouldWatchGenerationStatus(project)) {
        generationStatusValue = ref.watch(
          projectStatusProvider(activeProjectId),
        );
      }
      planValue?.whenData(_stopPollingWhenSettled);
      projectChatValue?.whenData(_stopPollingWhenRevisionFailed);
    }

    final chat = projectChatValue?.asData?.value;
    _syncMissingReplanCopyOutputs(state, chat);
    final scrollTrigger = (
      state.messages.length,
      chat?.plans.length ?? (isInOutputStage ? 1 : 0),
      chat?.messages.length ?? 0,
      chat?.operations.where(_showsOperationInTranscript).length ?? 0,
      state.assistantTyping,
      _generationScrollKey(generationStatusValue),
    );
    _maybeScrollToBottom(scrollTrigger);

    // Read the keyboard insets here, above the Scaffold: the Scaffold strips
    // them from the body's MediaQuery, and this read is also what rebuilds
    // the footers as the keyboard opens and closes.
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;
    final keyboardOpen = keyboardInset > 0;
    final footerMaxHeight = math.max(
      (MediaQuery.sizeOf(context).height - keyboardInset) * 0.5,
      96.0,
    );

    // Material DrawerController fork: same finger-following drag, but snaps
    // open at ~20% width instead of 50%. Must be a full-screen Stack sibling
    // (not Positioned) so mid-drag gesture identity matches Material.
    return Stack(
      fit: StackFit.expand,
      children: [
        Scaffold(
          appBar: AppBar(
            leading: EasyDrawerButton(controllerKey: _drawerKey),
            title: Text(screenTitle),
            actions: [
              if (isInOutputStage) ...[
                IconButton(
                  tooltip: 'New output in this chat',
                  onPressed: () {
                    setState(() => _projectId = null);
                    ref
                        .read(creationChatControllerProvider.notifier)
                        .startNewOutput();
                  },
                  icon: const Icon(Icons.add_circle_outline),
                ),
                IconButton(
                  tooltip: 'Book progress',
                  onPressed: () =>
                      context.push('/projects/$activeProjectId/handoff'),
                  icon: const Icon(Icons.menu_book_outlined),
                ),
                IconButton(
                  tooltip: 'Refresh',
                  onPressed: () => _refreshOutput(activeProjectId),
                  icon: const Icon(Icons.refresh),
                ),
              ] else ...[
                IconButton(
                  tooltip: 'New book chat',
                  onPressed: () => context.go('/books/new?fresh=true'),
                  icon: const Icon(Icons.add_circle_outline),
                ),
                IconButton(
                  tooltip: 'Advanced settings',
                  onPressed: !state.initializing
                      ? () => _openAdvancedSheet(state)
                      : null,
                  icon: const Icon(Icons.tune),
                ),
              ],
              IconButton(
                tooltip: 'Account',
                onPressed: () => context.push('/account'),
                icon: const Icon(Icons.account_circle_outlined),
              ),
            ],
          ),
          body: SafeArea(
            bottom: false,
            child: state.initializing
                ? const AppLoadingState(message: 'Loading chat')
                : state.initError != null && state.messages.isEmpty
                ? AppErrorState(
                    title: 'Chat unavailable',
                    message: state.initError!,
                    onRetry: () => unawaited(
                      ref
                          .read(creationChatControllerProvider.notifier)
                          .retryInit(
                            fresh: widget.startFresh,
                            draftId: widget.draftId,
                          ),
                    ),
                  )
                : Column(
                    children: [
                      if (!isInOutputStage)
                        _BriefHeader(state: state)
                      else if (state.outputs.length > 1)
                        _OutputSwitcher(
                          outputs: state.outputs,
                          activeProjectId: activeProjectId,
                          onSelect: (projectId) {
                            setState(_resetPlanReviewState);
                            ref
                                .read(creationChatControllerProvider.notifier)
                                .selectOutput(projectId);
                          },
                        ),
                      if (state.warnings.isNotEmpty)
                        _ChatWarningsBanner(warnings: state.warnings),
                      Expanded(
                        child: NotificationListener<Notification>(
                          onNotification: _onTranscriptScrollNotification,
                          child: _Transcript(
                            state: state,
                            controller: _scrollController,
                            planValue: planValue,
                            projectChatValue: projectChatValue,
                            generationStatusValue: generationStatusValue,
                            planBusyAction: _planBusyAction,
                            activeProjectId: activeProjectId,
                            switchingProjectBranch: _projectChatBranchSwitching,
                            onSwitchProjectBranch: _switchProjectBranch,
                            onEditProjectMessage: _startProjectMessageEdit,
                            onOpenReplanCopy: _openReplanCopy,
                            onOpenPaywall: (message) => unawaited(
                              _openProjectChatPaywall(
                                projectId: activeProjectId,
                                project: planValue?.asData?.value,
                              ),
                            ),
                            onRetryFailedMessage: (localId) => unawaited(
                              ref
                                  .read(creationChatControllerProvider.notifier)
                                  .retryFailedMessage(localId)
                                  .catchError((_) {}),
                            ),
                            onDismissFailedMessage: (localId) => ref
                                .read(creationChatControllerProvider.notifier)
                                .dismissFailedMessage(localId),
                            onEditCreationMessage: _startCreationMessageEdit,
                            onSwitchCreationBranch: (message, direction) {
                              final messageId = message.id;
                              if (messageId == null) return;
                              unawaited(
                                ref
                                    .read(
                                      creationChatControllerProvider.notifier,
                                    )
                                    .switchBranch(
                                      messageId: messageId,
                                      direction: direction,
                                    ),
                              );
                            },
                            onRetryFailedOperation: (operation) => unawaited(
                              _retryFailedOperation(
                                project: planValue?.asData?.value,
                                operation: operation,
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (_editingProjectMessageId != null)
                        _EditingMessageBanner(
                          onCancel: _cancelProjectMessageEdit,
                        )
                      else if (_editingCreationMessageId != null)
                        _EditingMessageBanner(
                          onCancel: _cancelCreationMessageEdit,
                        ),
                      if (isInOutputStage)
                        _FooterLimiter(
                          maxHeight: footerMaxHeight,
                          child: _buildOutputFooter(
                            planValue!,
                            activeProjectId,
                            planningStatusValue: generationStatusValue,
                            keyboardOpen: keyboardOpen,
                          ),
                        )
                      else
                        _FooterLimiter(
                          maxHeight: footerMaxHeight,
                          child: _ConversationFooter(
                            state: state,
                            keyboardOpen: keyboardOpen,
                            composerController: _composerController,
                            onSend: _send,
                            onQuickReply: _send,
                            onAnswerOption: _send,
                            onAttach: () => _openAttachMenu(state),
                            onRetryAttachment: (localId) => unawaited(
                              ref
                                  .read(creationChatControllerProvider.notifier)
                                  .retryAttachment(localId),
                            ),
                            onRemoveAttachment: (localId) => unawaited(
                              ref
                                  .read(creationChatControllerProvider.notifier)
                                  .removeAttachment(localId),
                            ),
                            onBuild: _build,
                          ),
                        ),
                    ],
                  ),
          ),
        ),
        EasyDrawerController(
          key: _drawerKey,
          child: ChatHistoryDrawer(activeDraftId: activeDraftId),
        ),
      ],
    );
  }

  Future<void> _openProjectChatPaywall({
    required String? projectId,
    MobileProjectDetail? project,
  }) async {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: 'Add credits',
      message: project == null
          ? 'Add credits to apply this edit.'
          : 'Add credits to edit "${project.title}".',
    );
    ref.invalidate(billingProvider);
    if (projectId != null) {
      _refreshOutput(projectId);
    }
  }

  Future<void> _retryFailedOperation({
    required MobileProjectDetail? project,
    required MobileBookEditOperation operation,
  }) async {
    if (operation.isAutomaticRetryPending) {
      _refreshOutput(operation.projectId);
      return;
    }
    if (!operation.retryAvailable) {
      final submittedText = operation.submittedText?.trim();
      if (submittedText != null && submittedText.isNotEmpty) {
        _revisionController.text = submittedText;
        _revisionController.selection = TextSelection.collapsed(
          offset: submittedText.length,
        );
      }
      _refreshOutput(operation.projectId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            submittedText == null || submittedText.isEmpty
                ? 'Edit the request below, then send it again.'
                : 'The original request is ready to edit and send again.',
          ),
        ),
      );
      return;
    }
    setState(() => _planBusyAction = 'retry-${operation.id}');
    try {
      final retried = await ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: operation.projectId,
            operationId: operation.id,
            requestId:
                operation.requestId ??
                'retry-${operation.id}-${DateTime.now().microsecondsSinceEpoch}',
          );
      if (!mounted) return;
      setState(() {
        _planBusyAction = 'revise';
        _pendingRevisionOperationId = retried.id;
        if (project?.plan != null) {
          _pendingRevisionPlanKey = _planKey(project!.plan!);
        }
      });
      _startPlanPoll();
      _refreshOutput(operation.projectId);
    } catch (error) {
      if (!mounted) return;
      setState(() => _planBusyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  String? _activeProjectId(CreationChatState state) {
    if (state.composingNewOutput) return null;
    return state.activeProjectId ?? _projectId ?? state.createdProjectId;
  }

  bool _hasOutput(CreationChatState state, String projectId) {
    return state.outputs.any((output) => output.projectId == projectId);
  }

  void _syncMissingReplanCopyOutputs(
    CreationChatState state,
    MobileProjectChat? chat,
  ) {
    if (chat == null || state.draftId == null) return;
    final knownOutputIds = state.outputs
        .map((output) => output.projectId)
        .toSet();
    var shouldSync = false;
    for (final message in chat.messages) {
      if (!message.isAssistant) continue;
      final targetProjectId = message.replanCopyTargetProjectId;
      if (targetProjectId == null ||
          knownOutputIds.contains(targetProjectId) ||
          _requestedReplanCopyOutputSyncs.contains(targetProjectId)) {
        continue;
      }
      _requestedReplanCopyOutputSyncs.add(targetProjectId);
      shouldSync = true;
    }
    if (!shouldSync) return;
    unawaited(_syncOutputsSilently());
  }

  Future<void> _syncOutputsSilently() async {
    try {
      await ref.read(creationChatControllerProvider.notifier).syncOutputs();
    } catch (_) {
      // The chip action retries and surfaces an error if the user taps it.
    }
  }

  void _resetPlanReviewState() {
    _editingProjectMessageId = null;
    _planBusyAction = null;
    _activePlanKey = null;
    _pendingRevisionPlanKey = null;
    _pendingRevisionOperationId = null;
    _planQuestionIndex = 0;
    _planQuestionAnswers = {};
  }

  Future<void> _openReplanCopy(String projectId) async {
    final controller = ref.read(creationChatControllerProvider.notifier);
    var state = ref.read(creationChatControllerProvider);
    if (!_hasOutput(state, projectId)) {
      try {
        await controller.syncOutputs();
      } catch (error) {
        if (!mounted) return;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
        return;
      }
      if (!mounted) return;
      state = ref.read(creationChatControllerProvider);
    }
    if (!_hasOutput(state, projectId)) {
      return;
    }
    setState(_resetPlanReviewState);
    controller.selectOutput(projectId);
  }

  void _refreshOutput(String projectId, {bool refreshStatus = true}) {
    ref.invalidate(projectDetailProvider(projectId));
    ref.invalidate(projectChatProvider(projectId));
    if (refreshStatus) {
      ref.invalidate(projectStatusProvider(projectId));
    }
  }

  String _screenTitle(
    CreationChatState state,
    String? sidebarTitle, {
    required bool preferSidebarTitle,
  }) {
    final title = sidebarTitle?.trim();
    if (preferSidebarTitle) {
      return title == null || title.isEmpty ? 'New book' : title;
    }
    if (title != null && title.isNotEmpty && state.sessionTitle == null) {
      return title;
    }
    return state.displayTitle;
  }

  String? _titleForDraft(List<MobileChatSession> sessions, String? draftId) {
    if (draftId == null) return null;
    for (final session in sessions) {
      if (session.draftId == draftId) {
        return session.title;
      }
    }
    return null;
  }

  Widget _buildOutputFooter(
    AsyncValue<MobileProjectDetail> planValue,
    String activeProjectId, {
    AsyncValue<MobileProjectStatus>? planningStatusValue,
    required bool keyboardOpen,
  }) {
    return planValue.when(
      loading: () => _PlanBuildingFooter(
        message: _planBusyAction == 'revise'
            ? 'Revising your book plan…'
            : 'Creating your book plan…',
        isRevision: _planBusyAction == 'revise',
        statusValue: planningStatusValue,
      ),
      error: (error, _) => _PlanErrorFooter(
        message: userFacingError(error),
        onRetry: () => _refreshOutput(activeProjectId),
      ),
      data: (project) {
        final plan = project.plan;
        if (plan == null) {
          return _PlanBuildingFooter(
            message: _planProgressLabel(project),
            statusValue: planningStatusValue,
          );
        }
        _syncPlanQuestionState(plan);
        if (project.status == 'planning' || _planBusyAction == 'revise') {
          return _PlanBuildingFooter(
            message: _planBusyAction == 'revise'
                ? 'Revising your book plan…'
                : _planProgressLabel(project),
            isRevision: true,
            statusValue: planningStatusValue,
          );
        }
        if (plan.isApproved) {
          return _ProjectChatFooter(
            controller: _composerController,
            enabled: !_projectChatSending,
            projectStatus: project.status,
            onSend: (message) =>
                _sendOutputMessage(activeProjectId, message.trim()),
          );
        }
        final hasMoreQuestions =
            plan.questions.isNotEmpty &&
            _planQuestionIndex < plan.questions.length;
        return _PlanFooter(
          plan: plan,
          questionIndex: _planQuestionIndex,
          hasMoreQuestions: hasMoreQuestions,
          keyboardOpen: keyboardOpen,
          isBusy: _planBusyAction != null || _projectChatSending,
          busyAction: _planBusyAction,
          revisionController: _revisionController,
          onSelectOption: (answer) =>
              _onPlanQuestionSelect(project, plan, answer),
          onSkip: () => _onPlanQuestionSkip(project, plan),
          onRevise: (msg) => _revise(project, msg),
          onApprove: () => _approve(project),
        );
      },
    );
  }

  void _syncStickToBottomFromUserScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    _stickToBottom = position.maxScrollExtent - position.pixels <= 80;
  }

  /// Re-engages follow-the-conversation scrolling. Submitting the composer is
  /// an explicit signal to watch the reply, even after scrolling up (which is
  /// how every message edit starts).
  void _resumeStickToBottom() {
    _stickToBottom = true;
    _scheduleStickyScroll(delay: const Duration(milliseconds: 16));
  }

  bool _onTranscriptScrollNotification(Notification notification) {
    if (notification is UserScrollNotification) {
      if (notification.metrics.axis != Axis.vertical) return false;
      _syncStickToBottomFromUserScroll();
      return false;
    }
    if (notification is ScrollMetricsNotification && _stickToBottom) {
      if (notification.metrics.axis != Axis.vertical) return false;
      // Content grew after the initial scroll (export card, images, etc.).
      _scheduleStickyScroll(delay: const Duration(milliseconds: 48));
    }
    return false;
  }

  void _maybeScrollToBottom(Object trigger) {
    final contentChanged = trigger != _lastScrollTrigger;
    if (contentChanged) {
      _lastScrollTrigger = trigger;
    }
    if (!contentChanged || !_stickToBottom) return;
    // Wait a beat so the new bubble can finish its first layout pass.
    _scheduleStickyScroll(delay: const Duration(milliseconds: 16));
  }

  void _scheduleStickyScroll({required Duration delay}) {
    _stickScrollTimer?.cancel();
    _stickScrollTimer = Timer(delay, () {
      _stickScrollTimer = null;
      if (!mounted || !_stickToBottom || !_scrollController.hasClients) return;
      final target = _scrollController.position.maxScrollExtent;
      final distance = (target - _scrollController.position.pixels).abs();
      if (distance <= 1) return;
      // Short glide for small growth (export expand); longer for new messages.
      final durationMs = distance < 120 ? 180 : 260;
      _scrollController.animateTo(
        target,
        duration: Duration(milliseconds: durationMs),
        curve: Curves.easeOutCubic,
      );
    });
  }

  Future<void> _send(String text) async {
    final trimmed = text.trim();
    final state = ref.read(creationChatControllerProvider);
    final activeProjectId = _activeProjectId(state);
    if (activeProjectId != null) {
      if (trimmed.isEmpty) return;
      await _sendOutputMessage(activeProjectId, trimmed);
      return;
    }
    // Attachment-only sends are allowed, like handing a file to a person.
    if (trimmed.isEmpty && !state.hasReadyAttachments) return;
    final editingCreationMessageId = _editingCreationMessageId;
    if (editingCreationMessageId != null) {
      await _sendCreationEdit(trimmed, editingCreationMessageId);
      return;
    }
    _composerController.clear();
    _resumeStickToBottom();
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .sendMessage(trimmed);
    } catch (_) {}
  }

  /// Routes an output-stage composer submit: an in-progress brainstorm edit
  /// goes to the creation chat (forking a branch there); everything else is
  /// a normal project chat message.
  Future<void> _sendOutputMessage(String projectId, String message) async {
    final editingCreationMessageId = _editingCreationMessageId;
    if (editingCreationMessageId != null) {
      await _sendCreationEdit(message, editingCreationMessageId);
      return;
    }
    await _sendProjectMessage(projectId: projectId, message: message);
  }

  Future<void> _sendCreationEdit(String message, String editMessageId) async {
    setState(() => _editingCreationMessageId = null);
    _composerController.clear();
    _resumeStickToBottom();
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .sendMessage(message, editMessageId: editMessageId);
    } catch (_) {}
  }

  void _startCreationMessageEdit(MobileCreationMessage message) {
    final state = ref.read(creationChatControllerProvider);
    if (message.id == null || state.isBusy || state.switchingBranch) return;
    setState(() {
      // Only one edit at a time: starting a brainstorm edit replaces any
      // in-progress project chat edit, and vice versa.
      _editingProjectMessageId = null;
      _editingCreationMessageId = message.id;
      _composerController.text = message.content;
      _composerController.selection = TextSelection.collapsed(
        offset: _composerController.text.length,
      );
    });
  }

  void _cancelCreationMessageEdit() {
    setState(() {
      _editingCreationMessageId = null;
      _composerController.clear();
    });
  }

  Future<void> _openAttachMenu(CreationChatState state) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Photo library'),
              subtitle: const Text('Use a photo as inspiration or notes'),
              onTap: () => Navigator.of(sheetContext).pop('gallery'),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () => Navigator.of(sheetContext).pop('camera'),
            ),
            ListTile(
              leading: const Icon(Icons.description_outlined),
              title: const Text('Document'),
              subtitle: const Text('PDF, Word, EPUB, text, or Markdown'),
              onTap: () => Navigator.of(sheetContext).pop('document'),
            ),
            ListTile(
              leading: Icon(
                state.hasSourceNotes
                    ? Icons.sticky_note_2
                    : Icons.sticky_note_2_outlined,
              ),
              title: const Text('Paste text notes'),
              subtitle: state.hasSourceNotes
                  ? const Text('Source notes added')
                  : null,
              onTap: () => Navigator.of(sheetContext).pop('notes'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case 'gallery':
        await _pickPhoto(ImageSource.gallery);
      case 'camera':
        await _pickPhoto(ImageSource.camera);
      case 'document':
        await _pickDocument();
      case 'notes':
        await _openSourceNotesSheet(ref.read(creationChatControllerProvider));
    }
  }

  Future<void> _pickPhoto(ImageSource source) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: source,
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      );
      if (picked == null || !mounted) return;
      final bytes = await picked.readAsBytes();
      await ref
          .read(creationChatControllerProvider.notifier)
          .attachFile(
            filename: picked.name,
            bytes: bytes,
            isPhoto: true,
            mimeType: picked.mimeType,
            localPath: picked.path,
          );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            source == ImageSource.camera
                ? 'Could not open the camera.'
                : 'Could not open your photos.',
          ),
        ),
      );
    }
  }

  static const _documentTypeGroup = XTypeGroup(
    label: 'Documents',
    extensions: [
      'pdf',
      'docx',
      'epub',
      'txt',
      'md',
      'markdown',
      'csv',
      'tsv',
      'json',
      'html',
      'htm',
      'rtf',
      'yaml',
      'yml',
      'srt',
      'log',
    ],
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/epub+zip',
      'application/rtf',
      'application/json',
      'text/*',
    ],
    uniformTypeIdentifiers: [
      'com.adobe.pdf',
      'org.openxmlformats.wordprocessingml.document',
      'org.idpf.epub-container',
      'public.text',
      'public.html',
      'public.rtf',
      'public.json',
      'net.daringfireball.markdown',
      'public.comma-separated-values-text',
    ],
  );

  Future<void> _pickDocument() async {
    try {
      final file = await openFile(
        acceptedTypeGroups: const [_documentTypeGroup],
      );
      if (file == null || !mounted) return;
      final bytes = await file.readAsBytes();
      if (bytes.isEmpty) {
        _showAttachError('Could not read that file.');
        return;
      }
      if (bytes.length > 20 * 1024 * 1024) {
        _showAttachError('That file is too large. Files up to 20 MB work.');
        return;
      }
      if (!mounted) return;
      await ref
          .read(creationChatControllerProvider.notifier)
          .attachFile(
            filename: file.name,
            bytes: bytes,
            isPhoto: false,
            localPath: file.path,
          );
    } catch (_) {
      _showAttachError('Could not open that file.');
    }
  }

  void _showAttachError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<MobileProjectChatSendResult?> _sendProjectMessage({
    required String projectId,
    required String message,
  }) async {
    final trimmed = message.trim();
    if (trimmed.isEmpty || _projectChatSending) return null;
    final editingMessageId = _editingProjectMessageId;
    final samePendingRequest =
        _pendingProjectRequestText == trimmed &&
        _pendingProjectEditMessageId == editingMessageId;
    if (!samePendingRequest) {
      _pendingProjectRequestText = trimmed;
      _pendingProjectEditMessageId = editingMessageId;
      _pendingProjectRequestId =
          'project-chat-${DateTime.now().microsecondsSinceEpoch}';
    }
    final requestId = _pendingProjectRequestId!;
    final shouldRestoreComposer = _composerController.text.trim() == trimmed;
    if (shouldRestoreComposer) {
      _composerController.clear();
    }
    setState(() => _projectChatSending = true);
    _resumeStickToBottom();
    try {
      final repository = ref.read(projectsRepositoryProvider);
      final result = editingMessageId != null
          ? await repository.editProjectChatMessage(
              projectId: projectId,
              messageId: editingMessageId,
              message: trimmed,
              requestId: requestId,
            )
          : await repository.sendProjectChatMessage(
              projectId: projectId,
              message: trimmed,
              requestId: requestId,
            );
      _pendingProjectRequestId = null;
      _pendingProjectRequestText = null;
      _pendingProjectEditMessageId = null;
      _refreshOutput(projectId);
      ref.invalidate(projectsProvider);
      ref.invalidate(billingProvider);
      if (!mounted) return result;
      setState(() {
        _projectChatSending = false;
        _editingProjectMessageId = null;
      });
      if (result.operation != null) {
        _startPlanPoll();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result.operation!.displayAction)),
        );
      }
      return result;
    } catch (error) {
      if (!mounted) return null;
      setState(() => _projectChatSending = false);
      // Always preserve the submitted text. Do not overwrite anything the user
      // typed while the network request was in flight.
      if (_composerController.text.trim().isEmpty) {
        _composerController.text = trimmed;
        _composerController.selection = TextSelection.collapsed(
          offset: trimmed.length,
        );
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
      return null;
    }
  }

  void _startProjectMessageEdit(MobileProjectChatMessage message) {
    if (_projectChatSending) return;
    setState(() {
      _editingCreationMessageId = null;
      _editingProjectMessageId = message.id;
      _composerController.text = message.content;
      _composerController.selection = TextSelection.collapsed(
        offset: _composerController.text.length,
      );
    });
  }

  void _cancelProjectMessageEdit() {
    setState(() {
      _editingProjectMessageId = null;
      _composerController.clear();
    });
  }

  Future<void> _switchProjectBranch(
    MobileProjectChatMessage message,
    String direction,
  ) async {
    if (_projectChatBranchSwitching) return;
    setState(() => _projectChatBranchSwitching = true);
    try {
      await ref
          .read(projectsRepositoryProvider)
          .switchProjectChatBranch(
            projectId: message.projectId,
            messageId: message.id,
            direction: direction,
          );
      _refreshOutput(message.projectId, refreshStatus: false);
      if (!mounted) return;
      setState(() => _projectChatBranchSwitching = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _projectChatBranchSwitching = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _build() async {
    try {
      final controller = ref.read(creationChatControllerProvider.notifier);
      final preflight = await controller.preflightBuildPlan();
      if (!mounted) return;
      if (preflight.requiresPageCount) {
        final selection = await _showPageCountSheet(preflight);
        if (selection == null) {
          return;
        }
        controller.setCustomTargetPages(
          selection.targetPages,
          source: selection.source,
        );
      }
      final result = await controller.buildPlan();
      ref.invalidate(projectsProvider);
      _refreshOutput(result.project.id);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      setState(() {
        _projectId = result.project.id;
        _resetPlanReviewState();
      });
      _startPlanPoll();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'INSUFFICIENT_CREDITS') {
        await showBillingPaywall(
          context,
          title: 'Credits needed',
          message: error.message,
        );
        ref.invalidate(billingProvider);
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.message)));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
      }
    }
  }

  Future<_PageCountSelection?> _showPageCountSheet(
    MobileCreationBuildPreflight preflight,
  ) {
    // Mirrors the plan-approval estimate (estimateApprovalCredits) so the
    // number a user picks a page count by is the number they are later asked
    // to approve. An unloaded billing map falls back to the canonical costs.
    final presets = ref.read(creationChatControllerProvider).presets;
    final creditCosts =
        ref.read(billingProvider).asData?.value.creditCosts ??
        const <String, dynamic>{};
    int estimateCredits(int pages) => estimateProjectCredits(
      bookType: presets.bookType,
      qualityPreset: presets.qualityPreset,
      imagesEnabled: presets.imagesEnabled,
      targetPages: pages,
      creditCosts: creditCosts,
    );
    return showModalBottomSheet<_PageCountSelection>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _PageCountPromptSheet(
        preflight: preflight,
        estimateCredits: estimateCredits,
      ),
    );
  }

  Future<void> _revise(MobileProjectDetail project, String message) async {
    final plan = project.plan;
    if (plan == null) return;
    try {
      final result = await _sendProjectMessage(
        projectId: project.id,
        message: message,
      );
      if (!mounted) return;
      final operation = result?.operation;
      if (operation == null) {
        setState(() => _planBusyAction = null);
        return;
      }
      setState(() {
        _planBusyAction = 'revise';
        _pendingRevisionPlanKey = _activePlanKey ?? _planKey(plan);
        _pendingRevisionOperationId = operation.id;
        _revisionController.clear();
      });
      _startPlanPoll();
    } catch (error) {
      if (!mounted) return;
      setState(() => _planBusyAction = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _approve(MobileProjectDetail project) async {
    final operation = await confirmAndApprovePlan(
      context,
      ref,
      project,
      onStart: () {
        if (mounted) setState(() => _planBusyAction = 'approve');
      },
      onSettled: () {
        if (mounted && _planBusyAction == 'approve') {
          setState(() => _planBusyAction = null);
        }
      },
    );
    if (operation == null || !mounted) return;
    _startPlanPoll();
    _refreshOutput(project.id);
    ref.invalidate(projectsProvider);
    ref.invalidate(billingProvider);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(operation.currentAction)));
  }

  void _onPlanQuestionSelect(
    MobileProjectDetail project,
    MobilePlan plan,
    String answer,
  ) {
    _planQuestionAnswers[_planQuestionIndex] = answer;
    final next = _planQuestionIndex + 1;
    if (next < plan.questions.length) {
      setState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  void _onPlanQuestionSkip(MobileProjectDetail project, MobilePlan plan) {
    final next = _planQuestionIndex + 1;
    if (next < plan.questions.length) {
      setState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  Future<void> _maybeSendPlanAnswers(
    MobileProjectDetail project,
    MobilePlan plan,
  ) async {
    final answers = Map<int, String>.from(_planQuestionAnswers);
    setState(() {
      _planQuestionIndex = plan.questions.length; // show revision bar
    });
    if (answers.isEmpty) return;
    final lines = ['Please revise the plan using these planning answers:'];
    for (var i = 0; i < plan.questions.length; i++) {
      final answer = answers[i];
      if (answer != null) lines.add('- ${plan.questions[i].prompt}: $answer');
    }
    await _revise(project, lines.join('\n'));
  }

  void _syncPlanQuestionState(MobilePlan plan) {
    final planKey = _planKey(plan);
    if (_activePlanKey == planKey) {
      if (_planQuestionIndex > plan.questions.length) {
        _planQuestionIndex = plan.questions.length;
      }
      return;
    }

    _activePlanKey = planKey;
    _planQuestionIndex = 0;
    _planQuestionAnswers = {};
  }

  Future<void> _openSourceNotesSheet(CreationChatState state) async {
    final controller = TextEditingController(text: state.sourceNotes);
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SourceNotesSheet(controller: controller),
    );
    controller.dispose();
    if (saved != null) {
      ref.read(creationChatControllerProvider.notifier).setSourceNotes(saved);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              saved.trim().isEmpty
                  ? 'Source notes cleared.'
                  : 'Source notes attached.',
            ),
          ),
        );
      }
    }
  }

  Future<void> _openAdvancedSheet(CreationChatState state) async {
    final controller = ref.read(creationChatControllerProvider.notifier);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AdvancedSheet(controller: controller),
    );
  }

  void _startPlanPoll() {
    _planRefreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      final id = _activeProjectId(ref.read(creationChatControllerProvider));
      if (id == null) return;
      if (ref.read(projectDetailProvider(id)).isLoading) return;
      _refreshOutput(id, refreshStatus: false);
    });
  }

  void _stopPollingWhenSettled(MobileProjectDetail project) {
    if (project.status == 'planning' ||
        project.status == 'generating' ||
        project.status == 'editing' ||
        project.plan == null) {
      return;
    }
    final settledPlanKey = _planKey(project.plan!);
    final stillWaitingForRevisedPlan =
        _pendingRevisionPlanKey != null &&
        _pendingRevisionPlanKey == settledPlanKey &&
        project.status != 'failed';
    if (stillWaitingForRevisedPlan) return;
    _planRefreshTimer?.cancel();
    _planRefreshTimer = null;
    if (_planBusyAction == 'revise') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _planBusyAction == 'revise') {
          setState(() {
            _planBusyAction = null;
            _pendingRevisionPlanKey = null;
            _pendingRevisionOperationId = null;
          });
        }
      });
    }
  }

  void _stopPollingWhenRevisionFailed(MobileProjectChat chat) {
    final pendingOperationId = _pendingRevisionOperationId;
    if (pendingOperationId == null) return;
    final failedPendingRevision = chat.operations.any(
      (operation) =>
          operation.id == pendingOperationId &&
          operation.isPlanRevision &&
          operation.isFailed,
    );
    if (!failedPendingRevision) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _pendingRevisionOperationId != pendingOperationId) {
        return;
      }
      setState(() {
        _planBusyAction = null;
        _pendingRevisionPlanKey = null;
        _pendingRevisionOperationId = null;
      });
      _planRefreshTimer?.cancel();
      _planRefreshTimer = null;
    });
  }
}

String _planKey(MobilePlan plan) => '${plan.id}:${plan.version}';

bool _showsOperationInTranscript(MobileBookEditOperation operation) =>
    operation.isRunning || operation.isFailed;

String _planSnapshotLabel(MobilePlan plan) {
  if (plan.isSuperseded) return 'Previous plan';
  if (plan.version > 1) return 'Revised plan ready';
  return 'Book plan ready';
}

String _planProgressLabel(MobileProjectDetail project) {
  final currentAction = project.currentAction.trim();
  final hasExistingPlan = project.plan != null;
  if (hasExistingPlan && project.status == 'planning') {
    return currentAction.isNotEmpty &&
            currentAction != 'Creating your book plan.' &&
            currentAction != 'Ready for review.'
        ? currentAction
        : 'Revising your book plan…';
  }
  if (hasExistingPlan &&
      (currentAction.isEmpty || currentAction == 'Creating your book plan.')) {
    return 'Revising your book plan…';
  }
  if (currentAction.isNotEmpty) {
    return currentAction;
  }
  return hasExistingPlan
      ? 'Revising your book plan…'
      : 'Building your book plan…';
}

bool _shouldWatchGenerationStatus(MobileProjectDetail? project) {
  if (project == null) return false;
  if (project.plan?.isApproved ?? false) return true;
  return switch (project.status) {
    'planning' ||
    'generating' ||
    'editing' ||
    'complete' ||
    'review_required' ||
    'failed' => true,
    _ => false,
  };
}

Object? _generationScrollKey(AsyncValue<MobileProjectStatus>? statusValue) {
  if (statusValue == null) return null;
  return statusValue.when(
    loading: () => 'loading',
    error: (error, _) => 'error:$error',
    data: (status) => (
      status.status,
      status.isComplete,
      status.hasFailure,
      status.quality.state,
      // Export actions change the bubble height when they appear.
      primaryUnlockedAvailableExport(status.exports)?.format,
    ),
  );
}

// ---------------------------------------------------------------------------
// Plan bubble (shown in the transcript once build is triggered)
// ---------------------------------------------------------------------------

class _PlanWithGenerationProgress extends StatelessWidget {
  const _PlanWithGenerationProgress({
    required this.child,
    required this.showGeneration,
    this.statusValue,
    this.projectId,
  });

  final Widget child;
  final bool showGeneration;
  final AsyncValue<MobileProjectStatus>? statusValue;
  final String? projectId;

  @override
  Widget build(BuildContext context) {
    final status = statusValue;
    final id = projectId;
    if (!showGeneration || status == null || id == null) {
      return child;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        child,
        _GenerationProgressBubble(projectId: id, statusValue: status),
      ],
    );
  }
}

class _GenerationProgressBubble extends ConsumerStatefulWidget {
  const _GenerationProgressBubble({
    required this.projectId,
    required this.statusValue,
  });

  final String projectId;
  final AsyncValue<MobileProjectStatus> statusValue;

  @override
  ConsumerState<_GenerationProgressBubble> createState() =>
      _GenerationProgressBubbleState();
}

class _GenerationProgressBubbleState
    extends ConsumerState<_GenerationProgressBubble> {
  String? _busyAction;

  Future<void> _downloadExport(MobileExportAvailability export) async {
    if (_busyAction != null) {
      return;
    }
    setState(() => _busyAction = projectExportDownloadAction(export));
    await openProjectExport(
      context: context,
      ref: ref,
      projectId: widget.projectId,
      export: export,
      isMounted: () => mounted,
      onRefresh: _refreshExportState,
    );
    if (!mounted) {
      return;
    }
    setState(() => _busyAction = null);
  }

  void _refreshExportState() {
    ref.invalidate(projectStatusProvider(widget.projectId));
    ref.invalidate(projectDetailProvider(widget.projectId));
  }

  @override
  Widget build(BuildContext context) {
    return widget.statusValue.when(
      loading: () => _GenerationProgressShell(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Theme.of(context).colorScheme.primary,
                semanticsLabel: 'Checking writing progress',
              ),
            ),
            const SizedBox(width: 10),
            const Flexible(child: Text('Checking writing progress…')),
          ],
        ),
      ),
      error: (_, _) => _GenerationProgressShell(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Progress is unavailable right now.'),
            const SizedBox(height: 8),
            _ViewProgressButton(projectId: widget.projectId),
          ],
        ),
      ),
      data: (status) {
        final colors = Theme.of(context).colorScheme;
        final progress = status.progressPercent.clamp(0, 100).toInt();
        final failureMessage = status.failureMessage?.trim();
        final isFailed = status.status == 'failed' || status.hasFailure;
        final reviewRequired = status.requiresReview;
        final downloadExport = status.isComplete && !reviewRequired
            ? primaryUnlockedAvailableExport(status.exports)
            : null;
        final title = reviewRequired
            ? 'Review required before export'
            : status.isComplete
            ? 'Ready to export'
            : isFailed
            ? 'Needs attention'
            : status.statusLabel;
        final detail =
            isFailed && failureMessage != null && failureMessage.isNotEmpty
            ? failureMessage
            : reviewRequired && status.quality.issues.isNotEmpty
            ? status.quality.issues.first.message
            : status.currentAction;
        return _GenerationProgressShell(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    isFailed || reviewRequired
                        ? Icons.error_outline
                        : status.isComplete
                        ? Icons.check_circle_outline
                        : Icons.auto_awesome_outlined,
                    color: isFailed || reviewRequired
                        ? colors.error
                        : colors.primary,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                detail,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Semantics(
                      label: 'Book generation progress',
                      value: '$progress percent complete',
                      child: ExcludeSemantics(
                        child: LinearProgressIndicator(value: progress / 100),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    '$progress%',
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ],
              ),
              const SizedBox(height: 12),
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
                    label: status.imageCount == 1
                        ? '1 visual'
                        : '${status.imageCount} visuals',
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (downloadExport != null)
                    _CompletionDownloadButton(
                      export: downloadExport,
                      busyAction: _busyAction,
                      onDownload: _downloadExport,
                    ),
                  if (status.isComplete)
                    _EditBookButton(projectId: widget.projectId),
                  if (reviewRequired &&
                      status.quality.affectedPageIndexes.isNotEmpty)
                    OutlinedButton.icon(
                      onPressed: () => context.push(
                        '/projects/${widget.projectId}/edit?pageIndex=${status.quality.affectedPageIndexes.first}',
                      ),
                      icon: const Icon(Icons.edit_note_outlined),
                      label: Text(
                        'Fix page ${status.quality.affectedPageIndexes.first}',
                      ),
                    ),
                  _ViewProgressButton(projectId: widget.projectId),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _GenerationProgressShell extends StatelessWidget {
  const _GenerationProgressShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: child,
        ),
      ),
    );
  }
}

class _CompletionDownloadButton extends StatelessWidget {
  const _CompletionDownloadButton({
    required this.export,
    required this.busyAction,
    required this.onDownload,
  });

  final MobileExportAvailability export;
  final String? busyAction;
  final Future<void> Function(MobileExportAvailability export) onDownload;

  @override
  Widget build(BuildContext context) {
    final action = projectExportDownloadAction(export);
    final isDownloading = busyAction == action;
    return FilledButton.icon(
      onPressed: isDownloading ? null : () => onDownload(export),
      icon: isDownloading
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Downloading export',
              ),
            )
          : const Icon(Icons.ios_share_outlined),
      label: Text(projectExportDownloadLabel(export, false)),
    );
  }
}

class _ViewProgressButton extends StatelessWidget {
  const _ViewProgressButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: () => context.push('/projects/$projectId/handoff'),
      icon: const Icon(Icons.menu_book_outlined),
      label: const Text('View progress'),
    );
  }
}

/// Opens manual Edit Mode so the user can change the book text themselves.
class _EditBookButton extends StatelessWidget {
  const _EditBookButton({required this.projectId});

  final String projectId;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: () => context.push('/projects/$projectId/edit'),
      icon: const Icon(Icons.edit_note_outlined),
      label: const Text('Edit book'),
    );
  }
}

class _PlanBubble extends StatefulWidget {
  const _PlanBubble.live({super.key, required this.planValue, this.busyAction})
    : plan = null;

  const _PlanBubble.snapshot({super.key, required this.plan})
    : planValue = null,
      busyAction = null;

  final AsyncValue<MobileProjectDetail>? planValue;
  final MobilePlan? plan;
  final String? busyAction;

  @override
  State<_PlanBubble> createState() => _PlanBubbleState();
}

class _PlanBubbleState extends State<_PlanBubble> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.plan;
    if (snapshot != null) {
      if (snapshot.isApproved) {
        return _buildCompactApprovedPlanCard(context, snapshot);
      }
      return _buildPlanCard(
        context,
        snapshot,
        label: _planSnapshotLabel(snapshot),
      );
    }

    return widget.planValue!.when(
      loading: () => _buildSpinnerBubble(
        context,
        widget.busyAction == 'revise'
            ? 'Revising your book plan…'
            : 'Building your book plan…',
        semanticsLabel: widget.busyAction == 'revise'
            ? 'Revising plan'
            : 'Building plan',
      ),
      error: (e, _) => _buildSpinnerBubble(context, 'Waiting for plan…'),
      data: (project) {
        final plan = project.plan;
        if (project.status == 'planning') {
          return _buildSpinnerBubble(
            context,
            _planProgressLabel(project),
            semanticsLabel: plan == null ? 'Building plan' : 'Revising plan',
          );
        }
        if (plan == null) {
          return _buildSpinnerBubble(
            context,
            project.currentAction.isNotEmpty
                ? project.currentAction
                : 'Building your book plan…',
          );
        }
        if (plan.isApproved) {
          return _buildCompactApprovedPlanCard(context, plan);
        }
        return _buildPlanCard(context, plan);
      },
    );
  }

  Widget _buildSpinnerBubble(
    BuildContext context,
    String label, {
    String semanticsLabel = 'Building plan',
  }) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: colors.primary,
                semanticsLabel: semanticsLabel,
              ),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                label,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCompactApprovedPlanCard(BuildContext context, MobilePlan plan) {
    final colors = Theme.of(context).colorScheme;
    final chapterLabel = plan.chapters.length == 1
        ? '1 chapter'
        : '${plan.chapters.length} chapters';
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Card(
          margin: const EdgeInsets.symmetric(vertical: 8),
          color: colors.surfaceContainerHighest,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () => context.push('/projects/${plan.projectId}'),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.task_alt_outlined, color: colors.primary),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Book plan approved',
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          plan.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            AppStatusBadge(
                              label: chapterLabel,
                              icon: Icons.format_list_numbered,
                              tone: AppNoticeTone.success,
                            ),
                            Text(
                              'Tap to open plan page',
                              style: Theme.of(context).textTheme.labelSmall
                                  ?.copyWith(color: colors.primary),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    Icons.open_in_new_outlined,
                    size: 18,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPlanCard(
    BuildContext context,
    MobilePlan plan, {
    String label = 'Book plan ready',
  }) {
    final colors = Theme.of(context).colorScheme;
    final radius = BorderRadius.circular(16);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: radius,
        border: Border.all(color: colors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Icon(
                    Icons.auto_stories_outlined,
                    color: colors.primary,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          plan.title,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  AppStatusBadge(
                    label: '${plan.chapters.length} ch.',
                    icon: Icons.format_list_numbered,
                    tone: AppNoticeTone.success,
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                    size: 20,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            Divider(height: 1, color: colors.outlineVariant),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: _PlanDetails(plan: plan),
            ),
          ],
        ],
      ),
    );
  }
}

class _PlanDetails extends StatelessWidget {
  const _PlanDetails({required this.plan});

  final MobilePlan plan;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if ((plan.subtitle ?? '').isNotEmpty) ...[
          Text(
            plan.subtitle!,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontStyle: FontStyle.italic,
            ),
          ),
          const SizedBox(height: 12),
        ],
        _PlanSection(
          icon: Icons.lightbulb_outline,
          title: 'Premise',
          text: plan.premise,
        ),
        const SizedBox(height: 10),
        _PlanSection(
          icon: Icons.groups_outlined,
          title: 'Audience',
          text: plan.audience,
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Icon(Icons.format_list_numbered, size: 15, color: colors.primary),
            const SizedBox(width: 6),
            Text(
              'Chapters',
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 8),
        for (final chapter in plan.chapters) ...[
          _ChapterRow(chapter: chapter),
          if (chapter != plan.chapters.last) const SizedBox(height: 6),
        ],
      ],
    );
  }
}

class _PlanSection extends StatelessWidget {
  const _PlanSection({
    required this.icon,
    required this.title,
    required this.text,
  });

  final IconData icon;
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 14, color: colors.primary),
            const SizedBox(width: 5),
            Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Text(text, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _ChapterRow extends StatelessWidget {
  const _ChapterRow({required this.chapter});

  final MobilePlanChapter chapter;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 22,
          child: Text(
            '${chapter.index}.',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w800,
              color: colors.primary,
            ),
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                chapter.title,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
              ),
              if (chapter.summary.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  chapter.summary,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Plan-stage footer
// ---------------------------------------------------------------------------

class _ProjectChatFooter extends StatelessWidget {
  const _ProjectChatFooter({
    required this.controller,
    required this.enabled,
    required this.projectStatus,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final String projectStatus;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final hintText = projectStatus == 'complete'
        ? 'Ask for an edit to this book…'
        : projectStatus == 'generating' || projectStatus == 'editing'
        ? 'Ask about this book…'
        : 'Ask for a change…';
    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  enabled: enabled,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: hintText,
                    filled: true,
                    fillColor: colors.surfaceContainerHigh,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: controller,
                builder: (context, value, _) {
                  final canSend = enabled && value.text.trim().isNotEmpty;
                  return IconButton.filled(
                    tooltip: 'Send',
                    onPressed: canSend ? () => onSend(controller.text) : null,
                    icon: const Icon(Icons.send_rounded),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanBuildingFooter extends StatelessWidget {
  const _PlanBuildingFooter({
    this.message = 'Creating your book plan…',
    this.isRevision = false,
    this.statusValue,
  });

  final String message;
  final bool isRevision;
  final AsyncValue<MobileProjectStatus>? statusValue;

  @override
  Widget build(BuildContext context) {
    final planningProgress = statusValue?.asData?.value.planningProgress;
    final progress = planningProgress?.percent;
    final steps = planningProgress?.steps ?? _fallbackPlanningSteps(isRevision);
    final activeStep = steps.where((step) => step.isActive).firstOrNull;
    final title = isRevision
        ? 'Revising your book plan'
        : 'Creating your book plan';
    final detail = activeStep?.label ?? message.replaceAll('…', '');
    final colors = Theme.of(context).colorScheme;

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.auto_awesome_outlined,
                    color: colors.primary,
                    size: 21,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  if (progress != null) ...[
                    const SizedBox(width: 12),
                    Text(
                      '$progress%',
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: colors.primary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
              Semantics(
                label: 'Book plan progress',
                value: progress == null
                    ? 'Working'
                    : '$progress percent complete',
                child: ExcludeSemantics(
                  child: LinearProgressIndicator(
                    value: progress == null ? null : progress / 100,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              for (final step in steps) _PlanningStepRow(step: step),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.notifications_none_outlined,
                    size: 16,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      'You can leave this chat — we’ll keep working.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanningStepRow extends StatelessWidget {
  const _PlanningStepRow({required this.step});

  final MobileProjectStatusStep step;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final stateLabel = step.isDone
        ? 'Done'
        : step.isFailed
        ? 'Needs attention'
        : step.isActive
        ? 'In progress'
        : 'Waiting';
    final icon = step.isDone
        ? Icons.check_circle
        : step.isFailed
        ? Icons.error
        : step.isActive
        ? Icons.radio_button_checked
        : Icons.radio_button_unchecked;
    final color = step.isDone || step.isActive
        ? colors.primary
        : step.isFailed
        ? colors.error
        : colors.outline;

    return Semantics(
      container: true,
      label: '${step.label}. $stateLabel.',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  step.label,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: step.isActive
                        ? colors.onSurface
                        : colors.onSurfaceVariant,
                    fontWeight: step.isActive ? FontWeight.w700 : null,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

List<MobileProjectStatusStep> _fallbackPlanningSteps(bool isRevision) => [
  MobileProjectStatusStep(
    key: 'understand',
    label: isRevision
        ? 'Understanding your changes'
        : 'Understanding your idea',
    status: 'active',
  ),
  MobileProjectStatusStep(
    key: 'shape',
    label: isRevision ? 'Improving your plan' : 'Shaping the chapters and flow',
    status: 'pending',
  ),
  MobileProjectStatusStep(
    key: 'finalize',
    label: isRevision ? 'Saving your revision' : 'Finalizing your plan',
    status: 'pending',
  ),
];

class _PlanFooter extends StatefulWidget {
  const _PlanFooter({
    required this.plan,
    required this.questionIndex,
    required this.hasMoreQuestions,
    required this.keyboardOpen,
    required this.isBusy,
    required this.busyAction,
    required this.revisionController,
    required this.onSelectOption,
    required this.onSkip,
    required this.onRevise,
    required this.onApprove,
  });

  final MobilePlan plan;
  final int questionIndex;
  final bool hasMoreQuestions;
  final bool keyboardOpen;
  final bool isBusy;
  final String? busyAction;
  final TextEditingController revisionController;
  final ValueChanged<String> onSelectOption;
  final VoidCallback onSkip;
  final ValueChanged<String> onRevise;
  final VoidCallback onApprove;

  @override
  State<_PlanFooter> createState() => _PlanFooterState();
}

class _PlanFooterState extends State<_PlanFooter> {
  final _revisionFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    _revisionFocus.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _revisionFocus.removeListener(_onFocusChanged);
    _revisionFocus.dispose();
    super.dispose();
  }

  void _onFocusChanged() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final plan = widget.plan;
    final busyAction = widget.busyAction;
    // While typing a revision, collapse the question panel to its prompt and
    // drop the Approve button so the composer stays visible above the
    // keyboard instead of overflowing off screen.
    final keyboardOpen = widget.keyboardOpen;
    final typingRevision = _revisionFocus.hasFocus && keyboardOpen;

    // Show a clear loading state while the plan is being revised.
    if (busyAction == 'revise') {
      return Material(
        color: colors.surface,
        elevation: 8,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: colors.primary,
                    semanticsLabel: 'Revising plan',
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  'Revising the plan…',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Collapsing must not change the child slots before the
              // composer: replacing or removing widgets there rebuilds the
              // composer's element, which drops focus and closes the
              // keyboard the user just opened.
              if (widget.hasMoreQuestions) ...[
                _PlanQuestionPanel(
                  key: ValueKey(widget.questionIndex),
                  plan: plan,
                  questionIndex: widget.questionIndex,
                  collapsed: typingRevision,
                  keyboardOpen: keyboardOpen,
                  isBusy: widget.isBusy,
                  onSelect: widget.onSelectOption,
                  onSkip: widget.onSkip,
                ),
                const SizedBox(height: 10),
                Divider(height: 1, color: colors.outlineVariant),
                const SizedBox(height: 10),
              ],
              _RevisionComposer(
                controller: widget.revisionController,
                focusNode: _revisionFocus,
                enabled: !widget.isBusy,
                onSend: widget.onRevise,
              ),
              if (!keyboardOpen) ...[
                const SizedBox(height: 8),
                _ApproveButton(
                  approving: busyAction == 'approve',
                  onApprove: (!widget.isBusy && busyAction == null)
                      ? widget.onApprove
                      : null,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanQuestionPanel extends StatefulWidget {
  const _PlanQuestionPanel({
    required this.plan,
    required this.questionIndex,
    required this.collapsed,
    required this.keyboardOpen,
    required this.isBusy,
    required this.onSelect,
    required this.onSkip,
    super.key,
  });

  final MobilePlan plan;
  final int questionIndex;

  /// While typing a revision below, only the prompt shows so the composer
  /// stays visible above the keyboard.
  final bool collapsed;
  final bool keyboardOpen;
  final bool isBusy;
  final ValueChanged<String> onSelect;
  final VoidCallback onSkip;

  @override
  State<_PlanQuestionPanel> createState() => _PlanQuestionPanelState();
}

class _PlanQuestionPanelState extends State<_PlanQuestionPanel> {
  final _customController = TextEditingController();
  bool _showCustomField = false;

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  void _submitCustom() {
    final text = _customController.text.trim();
    if (text.isNotEmpty) widget.onSelect(text);
  }

  @override
  Widget build(BuildContext context) {
    final question = widget.plan.questions[widget.questionIndex];
    final total = widget.plan.questions.length;
    final colors = Theme.of(context).colorScheme;
    final collapsed = widget.collapsed;
    // While typing a custom answer, hide the option chips (via Visibility so
    // the field's slot doesn't shift and drop focus) to keep it visible
    // above the keyboard.
    final typingCustom = _showCustomField && widget.keyboardOpen && !collapsed;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Question ${widget.questionIndex + 1} of $total',
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 4),
        Text(
          question.prompt,
          maxLines: (collapsed || typingCustom) ? 2 : null,
          overflow: (collapsed || typingCustom) ? TextOverflow.ellipsis : null,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (!collapsed) ...[
          const SizedBox(height: 8),
          Visibility(
            visible: !typingCustom,
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final option in question.options)
                  ActionChip(
                    label: Text(option),
                    onPressed: widget.isBusy
                        ? null
                        : () => widget.onSelect(option),
                  ),
                if (question.allowCustom && !_showCustomField)
                  ActionChip(
                    avatar: const Icon(Icons.edit_outlined, size: 16),
                    label: const Text('Custom…'),
                    onPressed: widget.isBusy
                        ? null
                        : () => setState(() => _showCustomField = true),
                  ),
                ActionChip(
                  avatar: const Icon(Icons.skip_next_outlined, size: 18),
                  label: const Text('Skip'),
                  onPressed: widget.isBusy ? null : widget.onSkip,
                ),
              ],
            ),
          ),
        ],
        if (!collapsed && _showCustomField) ...[
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _customController,
                  enabled: !widget.isBusy,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 3,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _submitCustom(),
                  decoration: InputDecoration(
                    hintText: 'Type your own answer…',
                    filled: true,
                    fillColor: colors.surfaceContainerHigh,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: _customController,
                builder: (context, value, _) {
                  return IconButton.filled(
                    tooltip: 'Submit answer',
                    onPressed: (!widget.isBusy && value.text.trim().isNotEmpty)
                        ? _submitCustom
                        : null,
                    icon: const Icon(Icons.send_rounded),
                  );
                },
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _RevisionComposer extends StatelessWidget {
  const _RevisionComposer({
    required this.controller,
    required this.enabled,
    required this.onSend,
    this.focusNode,
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onSend;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            focusNode: focusNode,
            enabled: enabled,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: 'Ask about or request a change to the plan…',
              filled: true,
              fillColor: colors.surfaceContainerHigh,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            final canSend = enabled && value.text.trim().isNotEmpty;
            return IconButton.filled(
              tooltip: 'Send revision',
              onPressed: canSend
                  ? () {
                      onSend(controller.text);
                      controller.clear();
                    }
                  : null,
              icon: const Icon(Icons.send_rounded),
            );
          },
        ),
      ],
    );
  }
}

class _ApproveButton extends StatelessWidget {
  const _ApproveButton({required this.approving, required this.onApprove});

  final bool approving;
  final VoidCallback? onApprove;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: onApprove,
      icon: approving
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Approving',
              ),
            )
          : const Icon(Icons.check_circle_outline),
      label: Text(approving ? 'Approving…' : 'Approve and start writing'),
    );
  }
}

// ---------------------------------------------------------------------------
// Chat-stage widgets (brief header, transcript, conversation footer)
// ---------------------------------------------------------------------------

class _BriefHeader extends StatefulWidget {
  const _BriefHeader({required this.state});

  final CreationChatState state;

  @override
  State<_BriefHeader> createState() => _BriefHeaderState();
}

class _BriefHeaderState extends State<_BriefHeader> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final brief = state.brief;
    final colors = Theme.of(context).colorScheme;
    final presets = state.presets;
    final typeTitle = bookTypeLabel(
      state.userChoices.contains(CreationChoice.bookType)
          ? presets.bookTypeChoice
          : 'auto',
    );

    return Material(
      color: colors.surfaceContainerHigh,
      child: Column(
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
              child: Row(
                children: [
                  Icon(Icons.menu_book_outlined, color: colors.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Book brief',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: colors.onSurfaceVariant),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          typeTitle,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
                  _ReadinessPill(readiness: state.readiness),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: _BriefDetails(
                state: state,
                brief: brief,
                presets: presets,
              ),
            ),
          Divider(height: 1, color: colors.outlineVariant),
        ],
      ),
    );
  }
}

class _BriefDetails extends StatelessWidget {
  const _BriefDetails({
    required this.state,
    required this.brief,
    required this.presets,
  });

  final CreationChatState state;
  final MobileBookRecipe? brief;
  final MobileCreationPresets presets;

  @override
  Widget build(BuildContext context) {
    final lane = state.detectedLane;
    final promise = brief == null ? '' : primaryPromise(brief!);
    final rows = <_BriefRow>[
      if ((brief?.audience ?? '').trim().isNotEmpty)
        _BriefRow(audienceLabel(lane), brief!.audience),
      if (promise.trim().isNotEmpty) _BriefRow(promiseLabel(lane), promise),
      if ((brief?.tone ?? '').trim().isNotEmpty) _BriefRow('Tone', brief!.tone),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            AppMetricChip(
              label: 'Type',
              value: bookTypeLabel(
                state.userChoices.contains(CreationChoice.bookType)
                    ? presets.bookTypeChoice
                    : 'auto',
              ),
            ),
            AppMetricChip(label: 'Size', value: pageCountLabelFor(presets)),
            AppMetricChip(
              label: 'Finish',
              value: qualityLabel(presets.qualityPreset),
            ),
            AppMetricChip(
              label: 'Visuals',
              value: presets.imagesEnabled ? 'Included' : 'Text-first',
            ),
            if (state.language != 'en')
              AppMetricChip(
                label: 'Language',
                value: languageLabel(state.language),
              ),
          ],
        ),
        if (state.userChoices.isNotEmpty) ...[
          const SizedBox(height: 8),
          const AppStatusBadge(
            label: 'Your choices applied',
            icon: Icons.tune_outlined,
            tone: AppNoticeTone.success,
          ),
        ],
        for (final row in rows) ...[
          const SizedBox(height: 10),
          Text(
            row.label,
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(row.value),
        ],
        if (state.readiness.missing.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            'Helpful to add',
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          for (final item in state.readiness.missing)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text('• $item'),
            ),
        ],
      ],
    );
  }
}

class _BriefRow {
  const _BriefRow(this.label, this.value);

  final String label;
  final String value;
}

class _ReadinessPill extends StatelessWidget {
  const _ReadinessPill({required this.readiness});

  final MobileCreationReadiness readiness;

  @override
  Widget build(BuildContext context) {
    final ready = readiness.canBuild;
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: AppStatusBadge(
        label: ready ? 'Ready' : '${readiness.score}%',
        icon: ready ? Icons.check_circle_outline : Icons.timelapse_outlined,
        tone: ready ? AppNoticeTone.success : AppNoticeTone.neutral,
      ),
    );
  }
}

class _OutputSwitcher extends StatelessWidget {
  const _OutputSwitcher({
    required this.outputs,
    required this.activeProjectId,
    required this.onSelect,
  });

  final List<MobileCreationOutput> outputs;
  final String activeProjectId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHigh,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 52,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: outputs.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final output = outputs[index];
                final selected = output.projectId == activeProjectId;
                return FilterChip(
                  selected: selected,
                  avatar: Icon(
                    selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_unchecked,
                    size: 18,
                  ),
                  label: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 180),
                    child: Text(
                      output.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  onSelected: (_) => onSelect(output.projectId),
                );
              },
            ),
          ),
          Divider(height: 1, color: colors.outlineVariant),
        ],
      ),
    );
  }
}

class _Transcript extends StatelessWidget {
  const _Transcript({
    required this.state,
    required this.controller,
    this.planValue,
    this.projectChatValue,
    this.generationStatusValue,
    this.planBusyAction,
    this.activeProjectId,
    this.switchingProjectBranch = false,
    this.onSwitchProjectBranch,
    this.onEditProjectMessage,
    this.onOpenReplanCopy,
    this.onOpenPaywall,
    this.onRetryFailedMessage,
    this.onDismissFailedMessage,
    this.onRetryFailedOperation,
    this.onEditCreationMessage,
    this.onSwitchCreationBranch,
  });

  final CreationChatState state;
  final ScrollController controller;
  final AsyncValue<MobileProjectDetail>? planValue;
  final AsyncValue<MobileProjectChat>? projectChatValue;
  final AsyncValue<MobileProjectStatus>? generationStatusValue;
  final String? planBusyAction;
  final String? activeProjectId;
  final bool switchingProjectBranch;
  final void Function(MobileProjectChatMessage message, String direction)?
  onSwitchProjectBranch;
  final void Function(MobileProjectChatMessage message)? onEditProjectMessage;
  final ValueChanged<String>? onOpenReplanCopy;
  final void Function(MobileProjectChatMessage message)? onOpenPaywall;
  final ValueChanged<String>? onRetryFailedMessage;
  final ValueChanged<String>? onDismissFailedMessage;
  final void Function(MobileBookEditOperation operation)?
  onRetryFailedOperation;
  final void Function(MobileCreationMessage message)? onEditCreationMessage;
  final void Function(MobileCreationMessage message, String direction)?
  onSwitchCreationBranch;

  @override
  Widget build(BuildContext context) {
    final projectChat = projectChatValue?.asData?.value;
    final currentProject = planValue?.asData?.value;
    final currentPlan = currentProject?.plan;
    final currentPlanKey = currentPlan == null ? null : _planKey(currentPlan);
    final showGenerationForCurrentPlan =
        generationStatusValue != null && (currentPlan?.isApproved ?? false);
    final projectItems = _projectTranscriptItems(projectChat);
    final hasLivePlanBubble =
        planValue != null &&
        _showsLivePlanBubble(planValue!, projectChat, planBusyAction);
    final hasTyping = state.assistantTyping && !hasLivePlanBubble;
    final itemCount =
        state.messages.length +
        (hasTyping ? 1 : 0) +
        (hasLivePlanBubble ? 1 : 0) +
        projectItems.length;

    return ListView.builder(
      controller: controller,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        var cursor = state.messages.length;
        if (index >= cursor && index < cursor + projectItems.length) {
          final item = projectItems[index - cursor];
          final plan = item.plan;
          if (plan != null) {
            return _PlanWithGenerationProgress(
              showGeneration:
                  showGenerationForCurrentPlan &&
                  currentPlanKey == _planKey(plan),
              statusValue: generationStatusValue,
              projectId: plan.projectId,
              child: _PlanBubble.snapshot(
                key: ValueKey('project-plan-${plan.id}'),
                plan: plan,
              ),
            );
          }
          final operation = item.operation;
          if (operation != null) {
            return _OutputOperationBubble(
              operation: operation,
              onRetry: operation.isFailed && onRetryFailedOperation != null
                  ? () => onRetryFailedOperation!(operation)
                  : null,
            );
          }
          return _ProjectChatMessageBubble(
            message: item.message!,
            switchingBranch: switchingProjectBranch,
            activeProjectId: activeProjectId,
            onSwitchBranch: onSwitchProjectBranch,
            onEdit: onEditProjectMessage,
            onOpenReplanCopy: onOpenReplanCopy,
            onOpenPaywall: item.message!.hasInsufficientCredits
                ? onOpenPaywall
                : null,
          );
        }
        cursor += projectItems.length;
        if (hasLivePlanBubble && index == cursor) {
          return _PlanWithGenerationProgress(
            showGeneration: showGenerationForCurrentPlan,
            statusValue: generationStatusValue,
            projectId: currentProject?.id,
            child: _PlanBubble.live(
              key: const ValueKey('project-plan-live'),
              planValue: planValue!,
              busyAction: planBusyAction,
            ),
          );
        }
        if (hasLivePlanBubble) cursor++;
        if (hasTyping && index == cursor) {
          return const _TypingBubble();
        }
        return _MessageBubble(
          message: state.messages[index],
          attachmentThumbnails: state.attachmentThumbnails,
          attachmentUrls: state.attachmentUrls,
          onRetryFailed: onRetryFailedMessage,
          onDismissFailed: onDismissFailedMessage,
          onEdit: onEditCreationMessage,
          onSwitchBranch: onSwitchCreationBranch,
          switchingBranch: state.switchingBranch || state.isBusy,
        );
      },
    );
  }
}

List<_ProjectTranscriptItem> _projectTranscriptItems(MobileProjectChat? chat) {
  if (chat == null) return const <_ProjectTranscriptItem>[];
  final items = <_ProjectTranscriptItem>[
    for (final plan in chat.plans) _ProjectTranscriptItem.plan(plan),
    for (final message in chat.messages)
      _ProjectTranscriptItem.message(message),
    for (final operation
        in chat.operations.where(_showsOperationInTranscript).take(3))
      _ProjectTranscriptItem.operation(operation),
  ];
  items.sort((a, b) {
    final byTime = a.createdAt.compareTo(b.createdAt);
    if (byTime != 0) return byTime;
    return a.sortPriority.compareTo(b.sortPriority);
  });
  return items;
}

bool _showsLivePlanBubble(
  AsyncValue<MobileProjectDetail> planValue,
  MobileProjectChat? chat,
  String? planBusyAction,
) {
  final hasSnapshots = (chat?.plans.isNotEmpty ?? false);
  if (!hasSnapshots) return true;
  if (planBusyAction == 'revise') return true;
  return planValue.maybeWhen(
    data: (project) => project.status == 'planning' || project.plan == null,
    loading: () => true,
    orElse: () => false,
  );
}

class _ProjectTranscriptItem {
  const _ProjectTranscriptItem.message(this.message)
    : plan = null,
      operation = null;

  const _ProjectTranscriptItem.plan(this.plan)
    : message = null,
      operation = null;

  const _ProjectTranscriptItem.operation(this.operation)
    : message = null,
      plan = null;

  final MobileProjectChatMessage? message;
  final MobilePlan? plan;
  final MobileBookEditOperation? operation;

  DateTime get createdAt =>
      plan?.createdAt ?? message?.createdAt ?? operation!.createdAt;

  int get sortPriority {
    if (plan != null) return 0;
    if (message != null) return 1;
    return 2;
  }
}

class _EditingMessageBanner extends StatelessWidget {
  const _EditingMessageBanner({required this.onCancel});

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        child: Row(
          children: [
            Icon(Icons.edit_outlined, size: 18, color: colors.primary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'Editing message',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
            IconButton(
              tooltip: 'Cancel edit',
              visualDensity: VisualDensity.compact,
              onPressed: onCancel,
              icon: const Icon(Icons.close, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatWarningsBanner extends StatelessWidget {
  const _ChatWarningsBanner({required this.warnings});

  final List<String> warnings;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.info_outline,
              size: 18,
              color: colors.onTertiaryContainer,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                warnings.join(' '),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanErrorFooter extends StatelessWidget {
  const _PlanErrorFooter({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
          child: Row(
            children: [
              Icon(Icons.error_outline, color: colors.error, size: 20),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String? _formatChatTimestamp(DateTime? value) {
  if (value == null) return null;
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    this.attachmentThumbnails = const <String, String>{},
    this.attachmentUrls = const <String, String>{},
    this.onRetryFailed,
    this.onDismissFailed,
    this.onEdit,
    this.onSwitchBranch,
    this.switchingBranch = false,
  });

  final MobileCreationMessage message;
  final Map<String, String> attachmentThumbnails;
  final Map<String, String> attachmentUrls;
  final ValueChanged<String>? onRetryFailed;
  final ValueChanged<String>? onDismissFailed;
  final void Function(MobileCreationMessage message)? onEdit;
  final void Function(MobileCreationMessage message, String direction)?
  onSwitchBranch;
  final bool switchingBranch;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final failed = message.isFailedSend;
    final background = failed
        ? colors.errorContainer
        : isUser
        ? colors.primary
        : colors.surfaceContainerHighest;
    final foreground = failed
        ? colors.onErrorContainer
        : isUser
        ? colors.onPrimary
        : colors.onSurface;
    final hasText = message.content.trim().isNotEmpty;
    final timestamp = _formatChatTimestamp(message.createdAt);
    final localId = message.localId;
    final branch = message.branch;
    final canEdit = isUser && !failed && message.id != null && onEdit != null;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPressStart: (details) => showMessageActionsMenu(
          context: context,
          position: details.globalPosition,
          message: message.content,
          onEdit: canEdit ? () => onEdit!(message) : null,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 5),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.82,
          ),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(16),
              topRight: const Radius.circular(16),
              bottomLeft: Radius.circular(isUser ? 16 : 4),
              bottomRight: Radius.circular(isUser ? 4 : 16),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (message.includedSourceNotes) ...[
                Text(
                  'Included source notes',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: foreground.withValues(alpha: 0.85),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
              ],
              if (message.hasAttachments) ...[
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final attachment in message.attachments)
                      _MessageAttachmentChip(
                        attachment: attachment,
                        thumbnailPath: attachmentThumbnails[attachment.id],
                        remoteUrl: attachmentUrls[attachment.id],
                        foreground: foreground,
                      ),
                  ],
                ),
                if (hasText) const SizedBox(height: 6),
              ],
              if (hasText)
                Text(
                  message.content,
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(color: foreground),
                ),
              if (timestamp != null) ...[
                const SizedBox(height: 6),
                Text(
                  timestamp,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: foreground.withValues(alpha: 0.7),
                  ),
                ),
              ],
              if (branch != null && onSwitchBranch != null) ...[
                const SizedBox(height: 8),
                BranchNavigator(
                  branch: branch,
                  foreground: foreground,
                  switching: switchingBranch,
                  onPrevious: () => onSwitchBranch!(message, 'previous'),
                  onNext: () => onSwitchBranch!(message, 'next'),
                ),
              ],
              if (failed && localId != null) ...[
                const SizedBox(height: 8),
                Text(
                  message.sendError ?? 'Message failed to send.',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: foreground,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    if (onRetryFailed != null)
                      TextButton(
                        onPressed: () => onRetryFailed!(localId),
                        style: TextButton.styleFrom(
                          foregroundColor: foreground,
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Retry'),
                      ),
                    if (onDismissFailed != null)
                      TextButton(
                        onPressed: () => onDismissFailed!(localId),
                        style: TextButton.styleFrom(
                          foregroundColor: foreground,
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Dismiss'),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _MessageAttachmentChip extends ConsumerWidget {
  const _MessageAttachmentChip({
    required this.attachment,
    required this.foreground,
    this.thumbnailPath,
    this.remoteUrl,
  });

  final MobileCreationMessageAttachment attachment;
  final Color foreground;
  final String? thumbnailPath;

  /// Server copy of the file, used when no local thumbnail exists (app
  /// restart or another device).
  final String? remoteUrl;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!attachment.isPhoto) {
      return _documentChip(context, ref);
    }
    final path = thumbnailPath;
    if (path != null && File(path).existsSync()) {
      return _tappablePhoto(
        context,
        ref,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.file(
            File(path),
            width: 120,
            height: 120,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => _remotePhotoOrChip(context, ref),
          ),
        ),
        localPath: path,
      );
    }
    return _remotePhotoOrChip(context, ref);
  }

  Widget _tappablePhoto(
    BuildContext context,
    WidgetRef ref, {
    required Widget child,
    String? localPath,
    String? networkUri,
    Map<String, String>? headers,
  }) {
    return Semantics(
      button: true,
      label: 'Preview ${attachment.name}',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => unawaited(
            showChatImagePreview(
              context: context,
              localPath: localPath,
              remoteUrl: networkUri,
              headers: headers,
              semanticLabel: attachment.name,
            ),
          ),
          child: child,
        ),
      ),
    );
  }

  Widget _remotePhotoOrChip(BuildContext context, WidgetRef ref) {
    final url = remoteUrl;
    if (url == null) {
      return _expiredPhotoChip(context);
    }
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(url).toString();
    return headersValue.when(
      data: (headers) => _tappablePhoto(
        context,
        ref,
        localPath: thumbnailPath,
        networkUri: uri,
        headers: headers,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.network(
            uri,
            headers: headers,
            width: 120,
            height: 120,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => _expiredPhotoChip(context),
          ),
        ),
      ),
      loading: () => const SizedBox.square(
        dimension: 120,
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      ),
      error: (_, _) => _expiredPhotoChip(context),
    );
  }

  Widget _documentChip(BuildContext context, WidgetRef ref) {
    final canOpen =
        (thumbnailPath != null && File(thumbnailPath!).existsSync()) ||
        remoteUrl != null;
    return Semantics(
      button: canOpen,
      label: canOpen ? 'Open ${attachment.name}' : attachment.name,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: canOpen
              ? () => unawaited(
                  openChatAttachment(
                    context: context,
                    ref: ref,
                    name: attachment.name,
                    localPath: thumbnailPath,
                    remoteUrl: remoteUrl,
                  ),
                )
              : null,
          child: _chipBody(
            context,
            icon: Icons.description_outlined,
            subtitle: canOpen ? 'Tap to open' : null,
          ),
        ),
      ),
    );
  }

  Widget _expiredPhotoChip(BuildContext context) {
    return _chipBody(
      context,
      icon: Icons.photo_outlined,
      subtitle: 'Preview expired',
    );
  }

  Widget _chipBody(
    BuildContext context, {
    required IconData icon,
    String? subtitle,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: foreground.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: foreground),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  attachment.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: foreground),
                ),
                if (subtitle != null)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: foreground.withValues(alpha: 0.75),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ProjectChatMessageBubble extends StatelessWidget {
  const _ProjectChatMessageBubble({
    required this.message,
    required this.switchingBranch,
    this.activeProjectId,
    this.onSwitchBranch,
    this.onEdit,
    this.onOpenReplanCopy,
    this.onOpenPaywall,
  });

  final MobileProjectChatMessage message;
  final bool switchingBranch;
  final String? activeProjectId;
  final void Function(MobileProjectChatMessage message, String direction)?
  onSwitchBranch;
  final void Function(MobileProjectChatMessage message)? onEdit;
  final ValueChanged<String>? onOpenReplanCopy;
  final void Function(MobileProjectChatMessage message)? onOpenPaywall;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final background = isUser ? colors.primary : colors.surfaceContainerHighest;
    final foreground = isUser ? colors.onPrimary : colors.onSurface;
    final contentCard = message.isAssistant ? message.contentCard : null;
    final branch = message.branch;
    final timestamp = _formatChatTimestamp(message.createdAt);
    final replanCopyTargetProjectId = message.isAssistant
        ? message.replanCopyTargetProjectId
        : null;
    final showReplanCopyLink =
        replanCopyTargetProjectId != null &&
        replanCopyTargetProjectId != activeProjectId &&
        onOpenReplanCopy != null;
    final bubble = GestureDetector(
      onLongPressStart: (details) => showMessageActionsMenu(
        context: context,
        position: details.globalPosition,
        message: message.content,
        onEdit: isUser && onEdit != null ? () => onEdit!(message) : null,
      ),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isUser ? 16 : 4),
            bottomRight: Radius.circular(isUser ? 4 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              message.content,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: foreground),
            ),
            if (timestamp != null) ...[
              const SizedBox(height: 6),
              Text(
                timestamp,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: foreground.withValues(alpha: 0.7),
                ),
              ),
            ],
            if (branch != null && onSwitchBranch != null) ...[
              const SizedBox(height: 8),
              BranchNavigator(
                branch: branch,
                foreground: foreground,
                switching: switchingBranch,
                onPrevious: () => onSwitchBranch!(message, 'previous'),
                onNext: () => onSwitchBranch!(message, 'next'),
              ),
            ],
            if (onOpenPaywall != null) ...[
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: () => onOpenPaywall!(message),
                icon: const Icon(Icons.add_card_outlined),
                label: const Text('Add credits'),
              ),
            ],
            if (showReplanCopyLink) ...[
              const SizedBox(height: 10),
              ActionChip(
                avatar: const Icon(Icons.open_in_new_outlined, size: 18),
                label: const Text('Open the new book'),
                onPressed: () => onOpenReplanCopy!(replanCopyTargetProjectId),
              ),
            ],
          ],
        ),
      ),
    );
    final manualEdit = message.isAssistant ? message.manualEdit : null;
    if (contentCard == null && manualEdit == null) {
      return Align(
        alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: bubble,
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          bubble,
          if (contentCard != null) _ContentCardBubble(card: contentCard),
          if (manualEdit != null) SavedExportCard(message: message),
        ],
      ),
    );
  }
}

/// Read-only book content (outline, chapter, or page) shown in the chat.
class _ContentCardBubble extends StatefulWidget {
  const _ContentCardBubble({required this.card});

  final MobileChatContentCard card;

  @override
  State<_ContentCardBubble> createState() => _ContentCardBubbleState();
}

class _ContentCardBubbleState extends State<_ContentCardBubble> {
  static const _previewLimit = 1200;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final card = widget.card;
    final icon = switch (card.type) {
      'page' => Icons.description_outlined,
      'chapter' => Icons.bookmark_outline,
      _ => Icons.list_alt_outlined,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 5),
      padding: const EdgeInsets.all(14),
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.88,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: colors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(card.title, style: theme.textTheme.titleSmall),
              ),
            ],
          ),
          for (final section in card.sections) ...[
            const SizedBox(height: 10),
            if (section.label.trim().isNotEmpty)
              Text(
                section.label,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            if (section.body.trim().isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                !_expanded && section.body.length > _previewLimit
                    ? '${section.body.substring(0, _previewLimit)}…'
                    : section.body,
                style: theme.textTheme.bodyMedium,
              ),
              if (section.body.length > _previewLimit)
                TextButton(
                  onPressed: () => setState(() => _expanded = !_expanded),
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  ),
                  child: Text(_expanded ? 'Show less' : 'Read more'),
                ),
            ],
          ],
        ],
      ),
    );
  }
}

class _OutputOperationBubble extends StatelessWidget {
  const _OutputOperationBubble({required this.operation, this.onRetry});

  final MobileBookEditOperation operation;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final waitingForRetry = operation.isAutomaticRetryPending;
    final isFailed = operation.isFailed && !waitingForRetry;
    final label = waitingForRetry
        ? operation.displayAction
        : isFailed && operation.isPlanRevision
        ? 'Plan revision failed. Your current plan is unchanged.'
        : operation.displayAction;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        decoration: BoxDecoration(
          color: isFailed ? colors.errorContainer : colors.secondaryContainer,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (isFailed)
                  Icon(
                    Icons.error_outline,
                    size: 18,
                    color: colors.onErrorContainer,
                    semanticLabel: operation.currentAction,
                  )
                else
                  SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: colors.primary,
                      semanticsLabel: operation.currentAction,
                    ),
                  ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: isFailed ? colors.onErrorContainer : null,
                    ),
                  ),
                ),
              ],
            ),
            if (isFailed) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  if (onRetry != null)
                    TextButton.icon(
                      onPressed: onRetry,
                      icon: Icon(
                        operation.retryAvailable
                            ? Icons.refresh
                            : Icons.edit_outlined,
                        size: 18,
                      ),
                      label: Text(
                        operation.retryAvailable
                            ? operation.isPlanRevision
                                  ? 'Retry revision'
                                  : 'Retry update'
                            : 'Edit request',
                      ),
                      style: TextButton.styleFrom(
                        foregroundColor: colors.onErrorContainer,
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                  if (operation.isPlanRevision)
                    TextButton.icon(
                      onPressed: () =>
                          context.push('/projects/${operation.projectId}'),
                      icon: const Icon(Icons.article_outlined, size: 18),
                      label: const Text('View current plan'),
                      style: TextButton.styleFrom(
                        foregroundColor: colors.onErrorContainer,
                        visualDensity: VisualDensity.compact,
                      ),
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

class _TypingBubble extends StatefulWidget {
  const _TypingBubble();

  @override
  State<_TypingBubble> createState() => _TypingBubbleState();
}

class _TypingBubbleState extends State<_TypingBubble> {
  // Staged status text so long turns feel alive rather than stuck.
  static const _stages = <String>[
    'Thinking…',
    'Thinking about your book…',
    'Shaping the details…',
    'Almost there…',
  ];

  Timer? _timer;
  int _stage = 0;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (!mounted) return;
      setState(() {
        _stage = (_stage + 1 < _stages.length) ? _stage + 1 : _stage;
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Assistant is thinking',
                color: colors.primary,
              ),
            ),
            const SizedBox(width: 10),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 250),
              child: Text(
                _stages[_stage],
                key: ValueKey(_stage),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Hard cap on footer height so the body Column can never overflow when the
/// keyboard shrinks the screen. Sits in an unbounded Column slot, so the cap
/// is computed by the screen from what the keyboard leaves visible.
/// `reverse: true` keeps the composer (bottom edge) visible when clamped.
class _FooterLimiter extends StatelessWidget {
  const _FooterLimiter({required this.maxHeight, required this.child});

  final double maxHeight;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: SingleChildScrollView(reverse: true, child: child),
    );
  }
}

class _ConversationFooter extends StatelessWidget {
  const _ConversationFooter({
    required this.state,
    required this.keyboardOpen,
    required this.composerController,
    required this.onSend,
    required this.onQuickReply,
    required this.onAnswerOption,
    required this.onAttach,
    required this.onRetryAttachment,
    required this.onRemoveAttachment,
    required this.onBuild,
  });

  final CreationChatState state;
  final bool keyboardOpen;
  final TextEditingController composerController;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onQuickReply;
  final ValueChanged<String> onAnswerOption;
  final VoidCallback onAttach;
  final ValueChanged<String> onRetryAttachment;
  final ValueChanged<String> onRemoveAttachment;
  final Future<void> Function() onBuild;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final question = state.question;
    final disabled = state.isBusy;

    return Material(
      color: colors.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Collapsing must not change the child slots before the
              // composer: replacing or removing widgets there rebuilds the
              // composer's element, which drops focus and closes the
              // keyboard the user just opened.
              if (question != null)
                _QuestionPanel(
                  question: question,
                  collapsed: keyboardOpen,
                  enabled: !disabled,
                  onSelect: onAnswerOption,
                )
              else if (state.quickReplies.isNotEmpty)
                Visibility(
                  visible: !keyboardOpen,
                  child: _ChipRow(
                    options: state.quickReplies,
                    enabled: !disabled,
                    icon: Icons.bolt_outlined,
                    onSelect: onQuickReply,
                  ),
                ),
              if (question != null || state.quickReplies.isNotEmpty)
                const SizedBox(height: 8),
              if (state.pendingAttachments.isNotEmpty) ...[
                _PendingAttachmentsRow(
                  attachments: state.pendingAttachments,
                  onRetry: onRetryAttachment,
                  onRemove: onRemoveAttachment,
                ),
                const SizedBox(height: 8),
              ],
              _Composer(
                controller: composerController,
                enabled: !disabled,
                hasQuestion: question != null,
                hasAttachments: state.pendingAttachments.isNotEmpty,
                canSendWithoutText:
                    state.hasReadyAttachments && !state.hasUploadingAttachments,
                waitingOnAttachments: state.hasUploadingAttachments,
                onAttach: onAttach,
                onSend: onSend,
              ),
              if (!keyboardOpen) ...[
                const SizedBox(height: 8),
                _BuildButton(
                  canBuild: state.canBuild,
                  building: state.building,
                  onBuild: onBuild,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _PendingAttachmentsRow extends StatelessWidget {
  const _PendingAttachmentsRow({
    required this.attachments,
    required this.onRetry,
    required this.onRemove,
  });

  final List<PendingCreationAttachment> attachments;
  final ValueChanged<String> onRetry;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final attachment = attachments[index];
          return _PendingAttachmentChip(
            attachment: attachment,
            onRetry: () => onRetry(attachment.localId),
            onRemove: () => onRemove(attachment.localId),
          );
        },
      ),
    );
  }
}

class _PendingAttachmentChip extends ConsumerWidget {
  const _PendingAttachmentChip({
    required this.attachment,
    required this.onRetry,
    required this.onRemove,
  });

  final PendingCreationAttachment attachment;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    final failedDetail = attachment.error?.trim();
    final statusLabel = attachment.isUploading
        ? 'Reading…'
        : attachment.isFailed
        ? (failedDetail == null || failedDetail.isEmpty
              ? 'Failed — tap to retry'
              : failedDetail)
        : attachment.attachment?.pages != null
        ? '${attachment.attachment!.pages} pages read'
        : 'Ready to send';
    return Semantics(
      label: 'Attachment ${attachment.name}, $statusLabel',
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: attachment.isFailed
            ? onRetry
            : attachment.isReady
            ? () => unawaited(_previewOrOpen(context, ref))
            : null,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: attachment.isFailed
                ? colors.errorContainer
                : colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _attachmentLeading(colors, ref),
              const SizedBox(width: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      attachment.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.labelMedium,
                    ),
                    Text(
                      statusLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.labelSmall?.copyWith(
                        color: attachment.isFailed
                            ? colors.onErrorContainer
                            : colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 4),
              InkWell(
                customBorder: const CircleBorder(),
                onTap: onRemove,
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child: Icon(Icons.close, size: 16),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _previewOrOpen(BuildContext context, WidgetRef ref) async {
    final localPath = attachment.localPath;
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto) {
      final resolved = resolveChatAssetUri(ref: ref, remoteUrl: remoteUrl);
      await showChatImagePreview(
        context: context,
        localPath: localPath,
        remoteUrl: resolved?.uri,
        headers: resolved?.headers,
        semanticLabel: attachment.name,
      );
      return;
    }
    await openChatAttachment(
      context: context,
      ref: ref,
      name: attachment.name,
      localPath: localPath,
      remoteUrl: remoteUrl,
      mimeType: attachment.mimeType,
    );
  }

  Widget _attachmentLeading(ColorScheme colors, WidgetRef ref) {
    if (attachment.isUploading) {
      return const SizedBox.square(
        dimension: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }
    if (attachment.isFailed) {
      return Icon(Icons.refresh, size: 20, color: colors.onErrorContainer);
    }
    final localPath = attachment.localPath;
    if (attachment.isPhoto &&
        localPath != null &&
        File(localPath).existsSync()) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image.file(
          File(localPath),
          width: 32,
          height: 32,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => const Icon(Icons.photo_outlined, size: 20),
        ),
      );
    }
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto && remoteUrl != null) {
      final headers = ref.watch(projectAssetHeadersProvider).value;
      final config = ref.watch(appConfigProvider);
      if (headers != null) {
        return ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: Image.network(
            config.apiBaseUrl.resolve(remoteUrl).toString(),
            headers: headers,
            width: 32,
            height: 32,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) =>
                const Icon(Icons.photo_outlined, size: 20),
          ),
        );
      }
    }
    return Icon(
      attachment.isPhoto ? Icons.photo_outlined : Icons.description_outlined,
      size: 20,
    );
  }
}

class _QuestionPanel extends StatelessWidget {
  const _QuestionPanel({
    required this.question,
    required this.collapsed,
    required this.enabled,
    required this.onSelect,
  });

  final MobileCreationQuestion question;

  /// While typing, only the prompt shows so the composer stays visible above
  /// the keyboard.
  final bool collapsed;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          question.prompt,
          maxLines: collapsed ? 2 : null,
          overflow: collapsed ? TextOverflow.ellipsis : null,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (!collapsed) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final option in question.options)
                ActionChip(
                  label: Text(option),
                  onPressed: enabled ? () => onSelect(option) : null,
                ),
              ActionChip(
                avatar: const Icon(Icons.skip_next_outlined, size: 18),
                label: const Text('Skip'),
                onPressed: enabled
                    ? () => onSelect('Skip this for now.')
                    : null,
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _ChipRow extends StatefulWidget {
  const _ChipRow({
    required this.options,
    required this.enabled,
    required this.icon,
    required this.onSelect,
  });

  final List<String> options;
  final bool enabled;
  final IconData icon;
  final ValueChanged<String> onSelect;

  @override
  State<_ChipRow> createState() => _ChipRowState();
}

class _ChipRowState extends State<_ChipRow> {
  final _scrollController = ScrollController();
  bool _moreBefore = false;
  bool _moreAfter = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_updateEdges);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateEdges());
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _updateEdges() {
    if (!mounted || !_scrollController.hasClients) return;
    final position = _scrollController.position;
    final moreBefore = position.extentBefore > 1;
    final moreAfter = position.extentAfter > 1;
    if (moreBefore == _moreBefore && moreAfter == _moreAfter) return;
    setState(() {
      _moreBefore = moreBefore;
      _moreAfter = moreAfter;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      height: 40,
      child: ShaderMask(
        shaderCallback: (bounds) => LinearGradient(
          begin: AlignmentDirectional.centerStart,
          end: AlignmentDirectional.centerEnd,
          colors: [
            _moreBefore ? Colors.transparent : Colors.white,
            Colors.white,
            Colors.white,
            _moreAfter ? Colors.transparent : Colors.white,
          ],
          stops: const [0.0, 0.07, 0.93, 1.0],
        ).createShader(bounds, textDirection: Directionality.of(context)),
        blendMode: BlendMode.dstIn,
        child: NotificationListener<ScrollMetricsNotification>(
          // Fades depend on content extent, which is only known after layout.
          onNotification: (_) {
            _updateEdges();
            return false;
          },
          child: ListView.separated(
            controller: _scrollController,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 2),
            itemCount: widget.options.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final option = widget.options[index];
              return ActionChip(
                avatar: Icon(widget.icon, size: 18, color: colors.primary),
                label: Text(option),
                onPressed: widget.enabled
                    ? () => widget.onSelect(option)
                    : null,
              );
            },
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.hasQuestion,
    required this.hasAttachments,
    required this.canSendWithoutText,
    required this.waitingOnAttachments,
    required this.onAttach,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool hasQuestion;
  final bool hasAttachments;

  /// Ready attachments allow sending with an empty message.
  final bool canSendWithoutText;

  /// While a file is still being read, sending waits so it isn't left behind.
  final bool waitingOnAttachments;
  final VoidCallback onAttach;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        IconButton(
          tooltip: 'Attach a photo, document, or notes',
          onPressed: enabled ? onAttach : null,
          icon: Icon(
            hasAttachments ? Icons.attach_file : Icons.attach_file_outlined,
            color: hasAttachments ? colors.primary : null,
          ),
        ),
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: hasAttachments
                  ? 'Add a note about the file…'
                  : hasQuestion
                  ? 'Answer the question above…'
                  : 'Describe your book…',
              filled: true,
              fillColor: colors.surfaceContainerHigh,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            final canSend =
                enabled &&
                !waitingOnAttachments &&
                (value.text.trim().isNotEmpty || canSendWithoutText);
            return IconButton.filled(
              tooltip: waitingOnAttachments ? 'Reading your file…' : 'Send',
              onPressed: canSend ? () => onSend(controller.text) : null,
              icon: const Icon(Icons.send_rounded),
            );
          },
        ),
      ],
    );
  }
}

class _BuildButton extends StatelessWidget {
  const _BuildButton({
    required this.canBuild,
    required this.building,
    required this.onBuild,
  });

  final bool canBuild;
  final bool building;
  final Future<void> Function() onBuild;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: canBuild && !building ? () => onBuild() : null,
      icon: building
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                semanticsLabel: 'Building the plan',
              ),
            )
          : const Icon(Icons.auto_awesome_outlined),
      label: Text(building ? 'Building the plan' : 'Build the plan'),
    );
  }
}

class _PageCountSelection {
  const _PageCountSelection({required this.targetPages, required this.source});

  final int targetPages;
  final String source;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

class _PageCountPromptSheet extends StatefulWidget {
  const _PageCountPromptSheet({
    required this.preflight,
    required this.estimateCredits,
  });

  final MobileCreationBuildPreflight preflight;
  final int Function(int targetPages) estimateCredits;

  @override
  State<_PageCountPromptSheet> createState() => _PageCountPromptSheetState();
}

class _PageCountPromptSheetState extends State<_PageCountPromptSheet> {
  final _customController = TextEditingController();

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  int? get _customPages {
    final value = int.tryParse(_customController.text.trim());
    if (value == null || value < 1 || value > 600) {
      return null;
    }
    return value;
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final colors = Theme.of(context).colorScheme;
    final recommendations = widget.preflight.recommendations;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'How many pages?',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Pick a page count before I build the plan. These suggestions come from your chat.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            for (final recommendation in recommendations) ...[
              Card(
                margin: EdgeInsets.zero,
                child: ListTile(
                  leading: const Icon(Icons.auto_awesome_outlined),
                  title: Text(recommendation.label),
                  subtitle: recommendation.description.isEmpty
                      ? null
                      : Text(recommendation.description),
                  trailing: Text(
                    '≈ ${widget.estimateCredits(recommendation.targetPages)} credits',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: colors.primary,
                    ),
                  ),
                  onTap: () => Navigator.of(context).pop(
                    _PageCountSelection(
                      targetPages: recommendation.targetPages,
                      source: 'recommended',
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
            if (recommendations.isNotEmpty) ...[
              Text(
                'Estimated full package cost, charged when you approve the plan.',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
            ],
            TextField(
              controller: _customController,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                labelText: 'Custom pages',
                helperText: _customPages == null
                    ? 'Enter a number from 1 to 600.'
                    : '≈ ${widget.estimateCredits(_customPages!)} credits '
                          'for $_customPages pages.',
              ),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) {
                final pages = _customPages;
                if (pages != null) {
                  Navigator.of(context).pop(
                    _PageCountSelection(targetPages: pages, source: 'settings'),
                  );
                }
              },
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ValueListenableBuilder<TextEditingValue>(
                    valueListenable: _customController,
                    builder: (context, value, child) {
                      final pages = _customPages;
                      return FilledButton(
                        onPressed: pages == null
                            ? null
                            : () => Navigator.of(context).pop(
                                _PageCountSelection(
                                  targetPages: pages,
                                  source: 'settings',
                                ),
                              ),
                        child: const Text('Use custom'),
                      );
                    },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SourceNotesSheet extends StatelessWidget {
  const _SourceNotesSheet({required this.controller});

  final TextEditingController controller;

  static const _limit = 12000;

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Source notes',
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 6),
          Text(
            'Paste an outline, lesson material, sales copy, or a story seed. Private reference, up to 12,000 characters.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            minLines: 6,
            maxLines: 12,
            maxLength: _limit,
            decoration: const InputDecoration(
              labelText: 'Source notes',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(''),
                  child: const Text('Clear'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: () => Navigator.of(context).pop(controller.text),
                  child: const Text('Attach'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AdvancedSheet extends ConsumerWidget {
  const _AdvancedSheet({required this.controller});

  final CreationChatController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(creationChatControllerProvider);
    final presets = state.presets;
    // Watched (not read) so the page-cost estimate reacts to Finish/Visuals
    // changes made in this same sheet.
    final creditCosts =
        ref.watch(billingProvider).asData?.value.creditCosts ??
        const <String, dynamic>{};
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(18, 4, 18, 18 + bottomInset),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Advanced settings',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'Override anything the studio chose. Your selections stick across the conversation.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            _BookTypeDropdown(
              title: 'Book type',
              yourChoice: state.userChoices.contains(CreationChoice.bookType),
              options: bookTypePresetOptions,
              selected: state.userChoices.contains(CreationChoice.bookType)
                  ? presets.bookTypeChoice
                  : 'auto',
              onChanged: controller.setBookType,
            ),
            const SizedBox(height: 14),
            _PageCountControl(
              title: 'Pages',
              yourChoice: state.userChoices.contains(CreationChoice.length),
              presets: presets,
              onAuto: controller.setPageCountAuto,
              onCustom: controller.setCustomTargetPages,
              estimateCredits: (pages) => estimateProjectCredits(
                bookType: presets.bookType,
                qualityPreset: presets.qualityPreset,
                imagesEnabled: presets.imagesEnabled,
                targetPages: pages,
                creditCosts: creditCosts,
              ),
            ),
            const SizedBox(height: 14),
            _AdvancedGroup(
              title: 'Finish',
              yourChoice: state.userChoices.contains(CreationChoice.finish),
              options: qualityPresetOptions,
              selected: presets.qualityPreset,
              onChanged: controller.setQualityPreset,
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: presets.imagesEnabled,
              onChanged: controller.setImagesEnabled,
              secondary: const Icon(Icons.image_outlined),
              title: Row(
                children: [
                  const Expanded(child: Text('Visuals')),
                  if (state.userChoices.contains(CreationChoice.visuals))
                    const AppStatusBadge(
                      label: 'Your choice',
                      icon: Icons.tune_outlined,
                    ),
                ],
              ),
              subtitle: Text(
                presets.imagesEnabled
                    ? 'Cover plus up to ${visualLimitFor(presets.bookType)} supporting visuals.'
                    : 'Text-first project with no planned visuals.',
              ),
            ),
            const SizedBox(height: 10),
            _LanguageField(
              language: state.language,
              yourChoice: state.userChoices.contains(CreationChoice.language),
              onChanged: controller.setLanguage,
            ),
            const SizedBox(height: 14),
            _ToneField(
              tone: state.optionalDetails.tone,
              yourChoice: state.userChoices.contains(CreationChoice.tone),
              onChanged: controller.setTone,
            ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }
}

class _BookTypeDropdown extends StatelessWidget {
  const _BookTypeDropdown({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final selectedOption = options.firstWhere(
      (option) => option.value == selected,
      orElse: () => options.first,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          key: ValueKey('book-type-$selected'),
          initialValue: selectedOption.value,
          isExpanded: true,
          decoration: InputDecoration(
            prefixIcon: Icon(selectedOption.icon),
            helperText: selectedOption.subtitle,
          ),
          items: [
            for (final option in options)
              DropdownMenuItem(
                value: option.value,
                child: Row(
                  children: [
                    Icon(option.icon, size: 20),
                    const SizedBox(width: 10),
                    Expanded(child: Text(option.title)),
                  ],
                ),
              ),
          ],
          onChanged: (value) {
            if (value != null) onChanged(value);
          },
        ),
      ],
    );
  }
}

class _PageCountControl extends StatefulWidget {
  const _PageCountControl({
    required this.title,
    required this.yourChoice,
    required this.presets,
    required this.onAuto,
    required this.onCustom,
    this.estimateCredits,
  });

  final String title;
  final bool yourChoice;
  final MobileCreationPresets presets;
  final VoidCallback onAuto;
  final void Function(int targetPages, {String source}) onCustom;
  final int Function(int targetPages)? estimateCredits;

  @override
  State<_PageCountControl> createState() => _PageCountControlState();
}

class _PageCountControlState extends State<_PageCountControl> {
  late final TextEditingController _controller;
  late bool _customSelected;

  @override
  void initState() {
    super.initState();
    _customSelected = widget.presets.pageCountMode == 'custom';
    _controller = TextEditingController(
      text: widget.presets.targetPages?.toString() ?? '',
    );
  }

  @override
  void didUpdateWidget(covariant _PageCountControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextCustom = widget.presets.pageCountMode == 'custom';
    if (nextCustom != _customSelected) {
      _customSelected = nextCustom;
    }
    final nextText = widget.presets.targetPages?.toString() ?? '';
    if (nextText != _controller.text && nextText.isNotEmpty) {
      _controller.text = nextText;
    }
    if (!nextCustom && _controller.text.isNotEmpty) {
      _controller.clear();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onCustomChanged(String value) {
    final pages = int.tryParse(value.trim());
    if (pages == null || pages < 1 || pages > 600) {
      return;
    }
    widget.onCustom(pages);
  }

  /// Estimated package cost for the currently entered custom page count, in
  /// the same terms as the plan-approval dialog.
  String? _customEstimateHelper() {
    final estimateCredits = widget.estimateCredits;
    final pages = int.tryParse(_controller.text.trim());
    if (estimateCredits == null || pages == null || pages < 1 || pages > 600) {
      return null;
    }
    return '≈ ${estimateCredits(pages)} credits for $pages pages, '
        'charged when you approve the plan.';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                widget.title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (widget.yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        AppChoiceTile(
          selected: !_customSelected,
          icon: Icons.auto_awesome_outlined,
          title: 'Auto',
          subtitle: 'Ask me before building if the chat does not say pages.',
          onTap: () {
            setState(() => _customSelected = false);
            widget.onAuto();
          },
        ),
        const SizedBox(height: 8),
        AppChoiceTile(
          selected: _customSelected,
          icon: Icons.format_list_numbered,
          title: 'Custom',
          subtitle: 'Use an exact page count.',
          onTap: () => setState(() => _customSelected = true),
        ),
        if (_customSelected) ...[
          const SizedBox(height: 8),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: InputDecoration(
              labelText: 'Pages',
              helperText:
                  _customEstimateHelper() ?? 'Enter a number from 1 to 600.',
              errorText:
                  _controller.text.isNotEmpty &&
                      (int.tryParse(_controller.text) == null ||
                          int.parse(_controller.text) < 1 ||
                          int.parse(_controller.text) > 600)
                  ? 'Use 1 to 600 pages.'
                  : null,
              filled: true,
              fillColor: colors.surface,
            ),
            onChanged: (value) {
              setState(() {});
              _onCustomChanged(value);
            },
          ),
        ],
      ],
    );
  }
}

class _AdvancedGroup extends StatelessWidget {
  const _AdvancedGroup({
    required this.title,
    required this.yourChoice,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final String title;
  final bool yourChoice;
  final List<CreationPresetOption> options;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        for (final option in options) ...[
          AppChoiceTile(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            subtitle: option.subtitle,
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _LanguageField extends StatelessWidget {
  const _LanguageField({
    required this.language,
    required this.yourChoice,
    required this.onChanged,
  });

  final String language;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final known = creationLanguageOptions.any((o) => o.code == language);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Language',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: known ? language : 'en',
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.translate_outlined),
          ),
          items: [
            for (final option in creationLanguageOptions)
              DropdownMenuItem(value: option.code, child: Text(option.label)),
          ],
          onChanged: (value) {
            if (value != null) onChanged(value);
          },
        ),
      ],
    );
  }
}

class _ToneField extends StatelessWidget {
  const _ToneField({
    required this.tone,
    required this.yourChoice,
    required this.onChanged,
  });

  final String tone;
  final bool yourChoice;
  final ValueChanged<String> onChanged;

  static const _toneExamples = [
    'warm',
    'funny',
    'practical',
    'polished',
    'gentle',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Tone',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (yourChoice)
              const AppStatusBadge(
                label: 'Your choice',
                icon: Icons.tune_outlined,
              ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final option in _toneExamples)
              ChoiceChip(
                label: Text(option),
                selected: tone.toLowerCase() == option,
                onSelected: (_) => onChanged(option),
              ),
          ],
        ),
      ],
    );
  }
}
