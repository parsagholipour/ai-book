import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import 'chat_history_drawer.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/easy_drawer_open.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/creation_prefs_store.dart';
import '../data/creation_repository.dart';
import '../data/projects_repository.dart';
import '../domain/creation_message_models.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'chat_media_preview.dart';
import 'chat_thinking_bubble.dart';
import 'creation_chat_controller.dart';
import 'creation_labels.dart';
import 'credit_cost_badge.dart';
import 'edit_proposal_card.dart';
import 'message_actions_menu.dart';
import 'message_hold_feedback.dart';
import 'plan_approval.dart';
import 'plan_revision_retry.dart';
import 'progress_step_row.dart';
import 'project_chat_bubbles.dart';
import 'project_export_actions.dart';
import 'saved_export_card.dart';

// This screen is one Dart library split across part files so the private
// widgets below can stay private while living in readable, focused files.
part 'creation_chat_plan.dart';
part 'creation_chat_generation.dart';
part 'creation_chat_plan_footers.dart';
part 'creation_chat_brief.dart';
part 'creation_chat_transcript.dart';
part 'creation_chat_bubbles.dart';
part 'creation_chat_composer.dart';
part 'creation_chat_sheets.dart';
part 'creation_chat_visuals_prompt.dart';
part 'creation_chat_output_send.dart';

class CreationChatScreen extends ConsumerStatefulWidget {
  const CreationChatScreen({super.key, this.startFresh = false, this.draftId});

  final bool startFresh;
  final String? draftId;

  @override
  ConsumerState<CreationChatScreen> createState() => _CreationChatScreenState();
}

class _CreationChatScreenState extends ConsumerState<CreationChatScreen>
    with _OutputChatSend {
  @override
  final _composerController = TextEditingController();
  final _revisionController = TextEditingController();
  final _scrollController = ScrollController();
  final _drawerKey = GlobalKey<EasyDrawerControllerState>();

  String? _projectId;
  String? _planBusyAction;
  String? _activePlanKey;
  String? _pendingRevisionPlanKey;
  String? _pendingRevisionOperationId;
  Object? _planRetryRequest;
  Timer? _planRefreshTimer;
  Timer? _stickScrollTimer;
  Object? _lastScrollTrigger;
  bool _stickToBottom = true;
  bool _projectChatBranchSwitching = false;
  String? _editingCreationMessageId;
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
    _planRetryRequest = null;
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
      ).showAppSnackBar(SnackBar(content: Text(error)));
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
                    setState(() {
                      _projectId = null;
                      _resetPlanReviewState();
                    });
                    ref
                        .read(creationChatControllerProvider.notifier)
                        .startNewOutput();
                  },
                  icon: const Icon(Icons.add_circle_outline),
                ),
                IconButton(
                  tooltip: 'Book progress',
                  onPressed: () => context.push('/projects/$activeProjectId'),
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
                  onPressed: !state.initializing ? openAdvancedSheet : null,
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
                            pendingProjectEcho: _pendingProjectEcho,
                            projectChatSending: _projectChatSending,
                            onRetryPendingProjectEcho: activeProjectId == null
                                ? null
                                : () => unawaited(
                                    _retryPendingProjectEcho(activeProjectId),
                                  ),
                            onDismissPendingProjectEcho:
                                _dismissPendingProjectEcho,
                            onSwitchProjectBranch: _switchProjectBranch,
                            onEditProjectMessage: _startProjectMessageEdit,
                            onOpenReplanCopy: _openReplanCopy,
                            onOpenPaywall: (message) => unawaited(
                              _openProjectChatPaywall(
                                projectId: activeProjectId,
                                project: planValue?.asData?.value,
                                credits: message.insufficientCreditsRequired,
                              ),
                            ),
                            onApplyEditProposal: activeProjectId == null
                                ? null
                                : (proposalId) => unawaited(
                                    _applyProjectEditProposal(
                                      projectId: activeProjectId,
                                      proposalId: proposalId,
                                    ),
                                  ),
                            onCancelEditProposal: activeProjectId == null
                                ? null
                                : (proposalId) => unawaited(
                                    _cancelProjectEditProposal(
                                      projectId: activeProjectId,
                                      proposalId: proposalId,
                                    ),
                                  ),
                            onUndoProjectEdit: activeProjectId == null
                                ? null
                                : () => unawaited(
                                    _undoProjectEdit(
                                      projectId: activeProjectId,
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
    int? credits,
  }) async {
    await showBillingPaywall(
      context,
      projectId: projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded(
        credits: credits,
        reason: project == null
            ? 'Applying this edit.'
            : 'Applying this edit to "${project.title}".',
      ),
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
      ScaffoldMessenger.of(context).showAppSnackBar(
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
            requestId: createPlanRevisionRetryRequestId(operation.id),
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
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
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
    _planRetryRequest = null;
    _activePlanKey = null;
    _pendingRevisionPlanKey = null;
    _pendingRevisionOperationId = null;
    _planQuestionIndex = 0;
    _planQuestionAnswers = {};
  }

  @override
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
        ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
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

  @override
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
        message: switch (_planBusyAction) {
          'revise' => 'Revising your book plan…',
          'retry-plan' => 'Retrying your book plan…',
          _ => 'Creating your book plan…',
        },
        isRevision: _planBusyAction == 'revise',
        statusValue: planningStatusValue,
      ),
      error: (error, _) => _PlanErrorFooter(
        message: userFacingError(error),
        onRetry: () => _refreshOutput(activeProjectId),
      ),
      data: (project) {
        final plan = project.plan;
        final liveStatus = planningStatusValue?.asData?.value;
        if (plan == null && _planGenerationFailed(project, liveStatus)) {
          return _PlanFailedFooter(
            message: _planFailureMessage(liveStatus),
            retrying: _planBusyAction == 'retry-plan',
            retryAvailable: liveStatus?.retryAvailable == true,
            onRetry: () => unawaited(_retryPlanGeneration(activeProjectId)),
            onRefresh: () => _refreshOutput(activeProjectId),
          );
        }
        if (plan == null) {
          final liveAction = liveStatus?.effectiveAction.trim();
          return _PlanBuildingFooter(
            message: liveAction != null && liveAction.isNotEmpty
                ? liveAction
                : _planProgressLabel(project),
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
            lockedLabel: _outputMessagingLockLabel(
              projectStatus: project.status,
              liveStatus: planningStatusValue?.asData?.value,
            ),
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

  Future<void> _retryPlanGeneration(String projectId) async {
    if (_planBusyAction != null) return;
    final retryRequest = Object();
    setState(() {
      _planBusyAction = 'retry-plan';
      _planRetryRequest = retryRequest;
    });
    try {
      final recovery = await ref
          .read(projectsRepositoryProvider)
          .resumeProject(projectId);
      if (!mounted) return;
      _refreshOutput(projectId);
      ref.invalidate(projectsProvider);
      if (!_finishPlanRetry(retryRequest, projectId)) return;
      _startPlanPoll();
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(recovery.currentAction)));
    } catch (error) {
      if (!mounted) return;
      if (!_finishPlanRetry(retryRequest, projectId)) return;
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  bool _finishPlanRetry(Object retryRequest, String projectId) {
    if (!identical(_planRetryRequest, retryRequest)) return false;
    final ownsBusyState = _planBusyAction == 'retry-plan';
    final stillActive =
        ownsBusyState &&
        _activeProjectId(ref.read(creationChatControllerProvider)) == projectId;
    setState(() {
      _planRetryRequest = null;
      if (ownsBusyState) {
        _planBusyAction = null;
      }
    });
    return stillActive;
  }

  void _syncStickToBottomFromUserScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    _stickToBottom = position.maxScrollExtent - position.pixels <= 80;
  }

  /// Re-engages follow-the-conversation scrolling. Submitting the composer is
  /// an explicit signal to watch the reply, even after scrolling up (which is
  /// how every message edit starts).
  @override
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
    AppHaptics.tap();
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
    final projectStatus = ref
        .read(projectDetailProvider(projectId))
        .asData
        ?.value
        .status;
    final liveStatus = ref.read(projectStatusProvider(projectId)).asData?.value;
    // The field is already disabled while this is non-null. Repeat the guard
    // at the callback boundary so a tap from the frame just before a live
    // status update cannot sneak a message into an active generation.
    if (_outputMessagingLockLabel(
          projectStatus: projectStatus,
          liveStatus: liveStatus,
        ) !=
        null) {
      return;
    }
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
        child: SingleChildScrollView(
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
              const Divider(height: 1),
              ListTile(
                key: const ValueKey('attach-import-book'),
                leading: const Icon(Icons.auto_stories_outlined),
                title: const Text('Import a finished manuscript'),
                subtitle: const Text(
                  'Bring your own book in to improve or continue it',
                ),
                onTap: () => Navigator.of(sheetContext).pop('import'),
              ),
            ],
          ),
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
        await openSourceNotesSheet(ref.read(creationChatControllerProvider));
      case 'import':
        if (mounted) context.push('/books/import');
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
      ScaffoldMessenger.of(context).showAppSnackBar(
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
    ).showAppSnackBar(SnackBar(content: Text(message)));
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
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _build() async {
    try {
      final controller = ref.read(creationChatControllerProvider.notifier);
      final preflight = await controller.preflightBuildPlan();
      if (!mounted) return;
      _PageCountSelection? selection;
      if (preflight.requiresPageCount) {
        selection = await _showPageCountSheet(preflight);
        if (selection == null) {
          return;
        }
        controller.setCustomTargetPages(
          selection.targetPages,
          source: selection.source,
        );
      }
      // The page count the illustration quote is priced against. When the sheet
      // ran it is the answer just given; otherwise the server resolved one from
      // the chat, and `detectedPageCount` is null exactly when the sheet ran.
      final targetPages =
          selection?.targetPages ??
          preflight.detectedPageCount?.targetPages ??
          ref.read(creationChatControllerProvider).presets.targetPages;
      if (targetPages != null) {
        final presets = ref.read(creationChatControllerProvider).presets;
        if (!await confirmVisuals(presets, targetPages)) {
          return;
        }
        if (!mounted) return;
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
      final paywallTitle = _paywallTitleForError(error.code);
      if (paywallTitle != null) {
        // A credits refusal carries its numbers, so it becomes the sheet's
        // credits-needed section; anything else the paywall can answer keeps
        // the server's own wording.
        final creditsNeeded = _paywallCreditsNeededForError(error);
        await showBillingPaywall(
          context,
          title: creditsNeeded == null ? paywallTitle : null,
          message: creditsNeeded == null ? error.message : null,
          creditsNeeded: creditsNeeded,
        );
        ref.invalidate(billingProvider);
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(error.message)));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
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
      coverEnabled: presets.coverEnabled,
      illustrationsEnabled: presets.illustrationsEnabled,
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
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
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
    // Approving spends credits and starts the long write: the heaviest,
    // least-reversible tap in the product, so it gets the weightiest feedback.
    AppHaptics.commit();
    _startPlanPoll();
    _refreshOutput(project.id);
    ref.invalidate(projectsProvider);
    ref.invalidate(billingProvider);
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(operation.currentAction)));
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

  @override
  void _startPlanPoll() {
    _planRefreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      final id = _activeProjectId(ref.read(creationChatControllerProvider));
      if (id == null) return;
      if (ref.read(projectDetailProvider(id)).isLoading) return;
      _refreshOutput(id, refreshStatus: false);
    });
  }

  void _stopPollingWhenSettled(MobileProjectDetail project) {
    if (project.status == 'failed') {
      _planRefreshTimer?.cancel();
      _planRefreshTimer = null;
      return;
    }
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
    operation.isRunning || operation.isFailed || operation.canUndo;

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

String? _outputMessagingLockLabel({
  required String? projectStatus,
  required MobileProjectStatus? liveStatus,
}) {
  if (liveStatus?.isLive ?? false) {
    return liveStatus!.status == 'generating'
        ? 'Generating your book…'
        : 'Regenerating your book…';
  }
  if (projectStatus == 'generating') {
    return 'Generating your book…';
  }
  if (projectStatus == 'editing') {
    return 'Regenerating your book…';
  }
  return null;
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
