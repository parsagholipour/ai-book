import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import 'chat_history_drawer.dart';
import 'creation_chat_navigation.dart';
import '../../../app/config/app_config.dart';
import '../../../app/theme/app_theme.dart';
import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../../../shared/ui/easy_drawer_open.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/domain/character_models.dart';
import '../../characters/domain/library_mentions.dart';
import '../../characters/presentation/character_avatar.dart';
import '../../characters/presentation/character_library_screen.dart';
import '../data/creation_prefs_store.dart';
import '../data/projects_repository.dart';
import '../domain/creation_message_models.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'branch_navigator.dart';
import 'chat_media_preview.dart';
import 'chat_reply_quote.dart';
import 'chat_thinking_bubble.dart';
import 'creation_chat_controller.dart';
import 'creation_cover_glimpse.dart';
import 'creation_labels.dart';
import 'credit_cost_badge.dart';
import 'edit_proposal_card.dart';
import 'message_actions_menu.dart';
import 'mention_chips_row.dart';
import 'message_hold_feedback.dart';
import 'plan_approval.dart';
import 'plan_revision_retry.dart';
import 'progress_step_row.dart';
import 'generation_retry_confirmation.dart';
import 'project_chat_bubbles.dart';
import 'project_chat_operations.dart';
import 'project_export_actions.dart';
import 'saved_export_card.dart';

// This screen is one Dart library split across part files so the private
// widgets below can stay private while living in readable, focused files.
part 'creation_chat_plan.dart';
part 'creation_chat_generation.dart';
part 'creation_chat_plan_footers.dart';
part 'creation_chat_brief.dart';
part 'creation_chat_brief_details.dart';
part 'creation_chat_transcript.dart';
part 'creation_chat_sources.dart';
part 'creation_chat_bubbles.dart';
part 'creation_chat_composer.dart';
part 'creation_chat_question_options.dart';
part 'creation_chat_sheets.dart';
part 'creation_chat_advanced_fields.dart';
part 'creation_chat_visuals_prompt.dart';
part 'creation_chat_output_send.dart';
part 'creation_chat_compose_context.dart';
part 'creation_chat_resume.dart';
part 'creation_chat_liveness.dart';
part 'creation_chat_transcript_actions.dart';
part 'creation_chat_attachments.dart';
part 'creation_chat_mentions.dart';
part 'creation_chat_plan_actions.dart';

class CreationChatScreen extends ConsumerStatefulWidget {
  const CreationChatScreen({
    super.key,
    this.startFresh = false,
    this.draftId,
    this.resetToken,
  });

  final bool startFresh;
  final String? draftId;

  /// A per-navigation nonce carried from [newBookChatLocation]. `startFresh`
  /// and `draftId` alone are `true`/`null` on every "New book" tap, so
  /// [didUpdateWidget] would otherwise think nothing changed on the second
  /// tap of a chat session and skip the reset entirely.
  final String? resetToken;

  @override
  ConsumerState<CreationChatScreen> createState() => _CreationChatScreenState();
}

class _CreationChatScreenState extends ConsumerState<CreationChatScreen>
    with
        _OutputChatSend,
        _CreationComposerContext,
        _CreationChatResume,
        _LiveOutputRefresh,
        _ComposerMentions {
  @override
  final _composerController = TextEditingController();
  @override
  final _composerFocusNode = FocusNode();
  final _revisionController = TextEditingController();
  @override
  final _scrollController = ScrollController();
  final _drawerKey = GlobalKey<EasyDrawerControllerState>();

  String? _projectId;
  @override
  String? _planBusyAction;
  String? _activePlanKey;
  @override
  String? _pendingRevisionPlanKey;
  @override
  String? _pendingRevisionOperationId;
  Timer? _stickScrollTimer;
  Object? _lastScrollTrigger;
  bool _stickToBottom = true;
  bool _projectChatBranchSwitching = false;
  final Set<String> _requestedReplanCopyOutputSyncs = <String>{};

  int _planQuestionIndex = 0;
  Map<int, String> _planQuestionAnswers = {};

  @override
  void _updateState(VoidCallback update) => setState(update);
  @override
  void _stopFollowingTranscript() => _stopFollowingTranscriptImpl();
  @override
  void _resumeStickToBottom() => _resumeStickToBottomImpl();

  @override
  void initState() {
    super.initState();
    _attachMentionListener();
    _initConversation();
  }

  @override
  void didUpdateWidget(covariant CreationChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.startFresh == widget.startFresh &&
        oldWidget.draftId == widget.draftId &&
        oldWidget.resetToken == widget.resetToken) {
      return;
    }
    _resetLocalConversationState();
    _initConversation(force: true);
  }

  @override
  void dispose() {
    _planRefreshTimer?.cancel();
    _stickScrollTimer?.cancel();
    _detachMentionListener();
    _composerController.dispose();
    _composerFocusNode.dispose();
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
    _resetMentions();
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
    _replyTarget = null;
    _messageAnchors.reset();
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

    AsyncValue<MobileProjectDetail>? planValue;
    AsyncValue<MobileProjectChat>? projectChatValue;
    AsyncValue<MobileProjectStatus>? generationStatusValue;
    if (isInOutputStage) {
      planValue = ref.watch(projectDetailProvider(activeProjectId));
      projectChatValue = ref.watch(projectChatProvider(activeProjectId));
      final project = planValue?.asData?.value;
      if (_shouldWatchGenerationStatus(project)) {
        final statusValue = ref.watch(projectStatusProvider(activeProjectId));
        generationStatusValue = statusValue;
        // The status stream is the only thing that knows the book is still
        // being worked on; the plan and the transcript arrive by polling.
        _syncLivePolling(activeProjectId, statusValue);
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
      _operationScrollKey(chat),
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
          // No title: the book is named by the brief header below, which is
          // always present — naming it twice a few pixels apart said nothing.
          appBar: AppBar(
            leading: EasyDrawerButton(controllerKey: _drawerKey),
            actions: [
              IconButton(
                tooltip: 'New book chat',
                onPressed: () => context.go(newBookChatLocation()),
                icon: const Icon(Icons.add_circle_outline),
              ),
              if (isInOutputStage) ...[
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
                      _BriefHeader(
                        state: state,
                        activeProjectId: activeProjectId,
                        planValue: planValue,
                        statusValue: generationStatusValue,
                        onOpenAdvanced: isInOutputStage
                            ? null
                            : openAdvancedSheet,
                        onEditTitle: isInOutputStage ? null : openTitleSheet,
                      ),
                      if (isInOutputStage && state.outputs.length > 1)
                        _OutputSwitcher(
                          outputs: state.outputs,
                          activeProjectId: activeProjectId,
                          onSelect: _selectOutput,
                        ),
                      if (state.warnings.isNotEmpty)
                        _ChatWarningsBanner(warnings: state.warnings),
                      Expanded(
                        child: NotificationListener<Notification>(
                          onNotification: _onTranscriptScrollNotification,
                          child: _Transcript(
                            state: state,
                            controller: _scrollController,
                            messageAnchorKey: _messageAnchors.keyFor,
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
                            onReplyToMessage: _startReply,
                            onOpenReplanCopy: _openReplanCopy,
                            onOpenPaywall: (message) => unawaited(
                              _openProjectChatPaywall(
                                projectId: activeProjectId,
                                project: planValue?.asData?.value,
                                credits: message.insufficientCreditsRequired,
                                resumeProposalId: message.editProposal?.id,
                              ),
                            ),
                            creditsReady:
                                activeProjectId != null &&
                                _creditsReadyProposalId != null,
                            onProceedCreditsReady: activeProjectId == null
                                ? null
                                : () => _proceedWithCreditsReadyEdit(
                                    activeProjectId,
                                  ),
                            onDismissCreditsReady: () => setState(
                              () => _creditsReadyProposalId = null,
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
                            undoingProjectEdit: _undoingProjectEdit,
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
                            onRetryGeneration: _retryBookGeneration,
                          ),
                        ),
                      ),
                      if (_editingProjectMessageId != null)
                        ChatComposerContextBanner.editing(
                          onOpen: _scrollToEditTarget,
                          onCancel: _cancelProjectMessageEdit,
                        )
                      else if (_editingCreationMessageId != null)
                        ChatComposerContextBanner.editing(
                          onOpen: _scrollToEditTarget,
                          onCancel: _cancelCreationMessageEdit,
                        )
                      else if (_replyTarget != null)
                        ChatComposerContextBanner.replying(
                          target: _replyTarget!,
                          onOpen: _scrollToReplyTarget,
                          onCancel: _cancelReply,
                        ),
                      // Persistent, unlike the suggestion strip below it: who
                      // the message will carry has to be visible whether or not
                      // an @token is being typed. Without this the UI was
                      // byte-identical whether a mention registered, never
                      // registered, or silently de-registered — which is how a
                      // book came to invent its own version of a saved
                      // character with nothing on screen to warn anyone.
                      MentionChipsRow(mentions: _attachedMentions),
                      // Above whichever footer is active: the same composer
                      // serves both stages, so one strip serves both too.
                      if (_mentionQuery != null)
                        _MentionSuggestionStrip(
                          query: _mentionQuery!.query,
                          onSelect: _insertMention,
                          onManage: () => unawaited(_openCharacterLibrary()),
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
                            composerFocusNode: _composerFocusNode,
                            onSend: _send,
                            onQuickReply: _send,
                            onAnswerOption: _send,
                            onSkipQuestion: _sendQuestionSkip,
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
    final quote = operation.recoveryQuote;
    if (quote == null) return;
    final confirmed = await confirmPaidGenerationRetry(
      context,
      ref,
      projectId: operation.projectId,
      quote: quote,
    );
    if (confirmed == null || !mounted) return;
    setState(() => _planBusyAction = 'retry-${operation.id}');
    try {
      final retried = await ref
          .read(projectsRepositoryProvider)
          .retryOperation(
            projectId: operation.projectId,
            operationId: operation.id,
            requestId: createPlanRevisionRetryRequestId(operation.id),
            retryToken: confirmed.retryToken,
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

  @override
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

  @override
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
    _selectOutput(projectId);
  }

  /// Moves the screen to another output in this chat, and starts watching it.
  ///
  /// The refresh is the load-bearing part: a replan copy is *mid-generation*
  /// when it is opened, and without re-arming the status stream and the poll
  /// its detail would be fetched once — while it still has no plan — and never
  /// again, leaving the footer on "Creating your book plan" forever.
  void _selectOutput(String projectId) {
    setState(_resetPlanReviewState);
    ref.read(creationChatControllerProvider.notifier).selectOutput(projectId);
    _refreshOutput(projectId);
    _startPlanPoll();
  }

  @override
  void _refreshOutput(String projectId, {bool refreshStatus = true}) {
    ref.invalidate(projectDetailProvider(projectId));
    ref.invalidate(projectChatProvider(projectId));
    if (refreshStatus) {
      ref.invalidate(projectStatusProvider(projectId));
    }
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
            focusNode: _composerFocusNode,
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
}

String _planKey(MobilePlan plan) => '${plan.id}:${plan.version}';

// Applied stays visible even once it can no longer be undone — the book chat
// keeps every applied and failed card as the book's history, and this
// transcript must read the same.
bool _showsOperationInTranscript(MobileBookEditOperation operation) =>
    operation.isRunning || operation.isFailed || operation.isApplied;

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
