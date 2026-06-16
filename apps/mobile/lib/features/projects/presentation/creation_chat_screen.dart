import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/projects_repository.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'creation_chat_controller.dart';
import 'creation_labels.dart';
import 'plan_approval.dart';
import 'project_detail_screen.dart';
import 'project_route_error.dart';

class CreationChatScreen extends ConsumerStatefulWidget {
  const CreationChatScreen({super.key});

  @override
  ConsumerState<CreationChatScreen> createState() => _CreationChatScreenState();
}

class _CreationChatScreenState extends ConsumerState<CreationChatScreen> {
  final _composerController = TextEditingController();
  final _revisionController = TextEditingController();
  final _scrollController = ScrollController();

  String? _projectId;
  String? _planBusyAction;
  Timer? _planRefreshTimer;
  int _lastMessageCount = 0;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) {
        ref.read(creationChatControllerProvider.notifier).init();
      }
    });
  }

  @override
  void dispose() {
    _planRefreshTimer?.cancel();
    _composerController.dispose();
    _revisionController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(
      creationChatControllerProvider.select((state) => state.initError),
      (previous, next) {
        if (next != null) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(SnackBar(content: Text(next)));
          ref.read(creationChatControllerProvider.notifier).clearError();
        }
      },
    );

    final state = ref.watch(creationChatControllerProvider);
    _maybeScrollToBottom(state.messages.length);

    if (_projectId != null) {
      return _buildPlanStage(context, _projectId!);
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('New book'),
        actions: [
          IconButton(
            tooltip: 'Advanced settings',
            onPressed: state.hasSession ? () => _openAdvancedSheet(state) : null,
            icon: const Icon(Icons.tune),
          ),
        ],
      ),
      body: SafeArea(
        bottom: false,
        child: state.initializing
            ? const AppLoadingState(message: 'Starting your Book Studio')
            : Column(
                children: [
                  _BriefHeader(state: state),
                  Expanded(child: _Transcript(state: state, controller: _scrollController)),
                  _ConversationFooter(
                    state: state,
                    composerController: _composerController,
                    onSend: _send,
                    onQuickReply: _send,
                    onAnswerOption: _send,
                    onAttachNotes: () => _openSourceNotesSheet(state),
                    onBuild: _build,
                  ),
                ],
              ),
      ),
    );
  }

  void _maybeScrollToBottom(int messageCount) {
    if (messageCount == _lastMessageCount) {
      return;
    }
    _lastMessageCount = messageCount;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) {
        return;
      }
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) {
      return;
    }
    _composerController.clear();
    try {
      await ref.read(creationChatControllerProvider.notifier).sendMessage(trimmed);
    } catch (_) {
      // Error surfaced via initError listener.
    }
  }

  Future<void> _build() async {
    try {
      final result = await ref
          .read(creationChatControllerProvider.notifier)
          .buildPlan();
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(result.project.id));
      ref.invalidate(billingProvider);
      if (!mounted) {
        return;
      }
      setState(() => _projectId = result.project.id);
      _startPlanPoll();
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
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

  Future<void> _openSourceNotesSheet(CreationChatState state) async {
    final controller = TextEditingController(text: state.sourceNotes);
    final saved = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => _SourceNotesSheet(controller: controller),
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
      builder: (sheetContext) {
        return _AdvancedSheet(controller: controller);
      },
    );
  }

  // ---- Plan stage (Phase C: review/revise/approve in place) ----

  Widget _buildPlanStage(BuildContext context, String projectId) {
    final projectValue = ref.watch(projectDetailProvider(projectId));
    final billingValue = ref.watch(billingProvider);
    projectValue.whenData(_stopPollingWhenSettled);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book plan'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: () => ref.invalidate(projectDetailProvider(projectId)),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: projectValue.when(
        data: (project) {
          if (project.plan == null) {
            return _PlanPending(project: project);
          }
          return RefreshIndicator(
            onRefresh: () async =>
                ref.invalidate(projectDetailProvider(projectId)),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 32),
              children: [
                const AppInlineNotice(
                  title: 'Your book plan is ready',
                  message:
                      'Read it through, ask for changes by chatting below, then approve to start writing.',
                  icon: Icons.auto_stories_outlined,
                  tone: AppNoticeTone.success,
                ),
                const SizedBox(height: 16),
                ProjectPlanReview(
                  project: project,
                  plan: project.plan!,
                  billing: billingValue.asData?.value,
                  revisionController: _revisionController,
                  busyAction: _planBusyAction,
                  onQuestionAnswers: (message) =>
                      _revise(project, message),
                  onRevisionRequest: (message) => _revise(project, message),
                  onApprovePlan: () => _approve(project),
                ),
              ],
            ),
          );
        },
        loading: () => const AppLoadingState(message: 'Loading book plan'),
        error: (error, stackTrace) => ProjectRouteErrorState(
          error: error,
          fallbackTitle: 'Plan unavailable',
          onRetry: () => ref.invalidate(projectDetailProvider(projectId)),
          onGoHome: () => context.go('/home'),
        ),
      ),
    );
  }

  Future<void> _revise(MobileProjectDetail project, String message) async {
    final plan = project.plan;
    if (plan == null) {
      return;
    }
    setState(() => _planBusyAction = 'revise');
    try {
      final operation = await ref
          .read(projectsRepositoryProvider)
          .revisePlan(planId: plan.id, message: message);
      if (!mounted) {
        return;
      }
      setState(() {
        _planBusyAction = null;
        _revisionController.clear();
      });
      _startPlanPoll();
      ref.invalidate(projectDetailProvider(project.id));
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(operation.currentAction)));
    } catch (error) {
      if (!mounted) {
        return;
      }
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
        if (mounted) {
          setState(() => _planBusyAction = 'approve');
        }
      },
      onSettled: () {
        if (mounted && _planBusyAction == 'approve') {
          setState(() => _planBusyAction = null);
        }
      },
    );
    if (operation == null || !mounted) {
      return;
    }
    context.push('/projects/${project.id}/handoff', extra: operation.currentAction);
  }

  void _startPlanPoll() {
    _planRefreshTimer ??= Timer.periodic(const Duration(seconds: 4), (_) {
      final id = _projectId;
      if (id == null) {
        return;
      }
      if (ref.read(projectDetailProvider(id)).isLoading) {
        return;
      }
      ref.invalidate(projectDetailProvider(id));
    });
  }

  void _stopPollingWhenSettled(MobileProjectDetail project) {
    if (_planRefreshTimer == null) {
      return;
    }
    if (project.status == 'planning' || project.plan == null) {
      return;
    }
    _planRefreshTimer?.cancel();
    _planRefreshTimer = null;
  }
}

class _PlanPending extends StatelessWidget {
  const _PlanPending({required this.project});

  final MobileProjectDetail project;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox.square(
                dimension: 40,
                child: CircularProgressIndicator(),
              ),
              const SizedBox(height: 18),
              Text(
                'Building your book plan',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                project.currentAction.isEmpty
                    ? 'The studio is turning your brief into chapters. This usually takes a moment.'
                    : project.currentAction,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

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
    final lane = state.detectedLane;

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
                          laneTitle(lane),
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
              child: _BriefDetails(state: state, brief: brief, presets: presets),
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
      if ((brief?.tone ?? '').trim().isNotEmpty)
        _BriefRow('Tone', brief!.tone),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            AppMetricChip(label: 'Type', value: bookTypeLabel(presets.bookType)),
            AppMetricChip(
              label: 'Size',
              value:
                  '${pageRangeFor(presets.bookType, presets.lengthPreset)} pages',
            ),
            AppMetricChip(
              label: 'Finish',
              value: qualityLabel(presets.qualityPreset),
            ),
            AppMetricChip(
              label: 'Visuals',
              value: presets.imagesEnabled ? 'Included' : 'Text-first',
            ),
            if (state.language != 'en')
              AppMetricChip(label: 'Language', value: languageLabel(state.language)),
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

class _Transcript extends StatelessWidget {
  const _Transcript({required this.state, required this.controller});

  final CreationChatState state;
  final ScrollController controller;

  @override
  Widget build(BuildContext context) {
    final itemCount =
        state.messages.length + (state.assistantTyping ? 1 : 0);
    return ListView.builder(
      controller: controller,
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (index >= state.messages.length) {
          return const _TypingBubble();
        }
        final message = state.messages[index];
        return _MessageBubble(message: message);
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});

  final MobileCreationMessage message;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = message.isUser;
    final background = isUser ? colors.primary : colors.surfaceContainerHighest;
    final foreground = isUser ? colors.onPrimary : colors.onSurface;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
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
        child: Text(
          message.content,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: foreground),
        ),
      ),
    );
  }
}

class _TypingBubble extends StatelessWidget {
  const _TypingBubble();

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
            Text(
              'Thinking…',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConversationFooter extends StatelessWidget {
  const _ConversationFooter({
    required this.state,
    required this.composerController,
    required this.onSend,
    required this.onQuickReply,
    required this.onAnswerOption,
    required this.onAttachNotes,
    required this.onBuild,
  });

  final CreationChatState state;
  final TextEditingController composerController;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onQuickReply;
  final ValueChanged<String> onAnswerOption;
  final VoidCallback onAttachNotes;
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
              if (question != null)
                _QuestionPanel(
                  question: question,
                  enabled: !disabled,
                  onSelect: onAnswerOption,
                )
              else if (state.quickReplies.isNotEmpty)
                _ChipRow(
                  options: state.quickReplies,
                  enabled: !disabled,
                  icon: Icons.bolt_outlined,
                  onSelect: onQuickReply,
                ),
              if (question != null || state.quickReplies.isNotEmpty)
                const SizedBox(height: 8),
              _Composer(
                controller: composerController,
                enabled: !disabled,
                hasSourceNotes: state.hasSourceNotes,
                onAttachNotes: onAttachNotes,
                onSend: onSend,
              ),
              const SizedBox(height: 8),
              _BuildButton(
                canBuild: state.canBuild,
                building: state.building,
                onBuild: onBuild,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QuestionPanel extends StatelessWidget {
  const _QuestionPanel({
    required this.question,
    required this.enabled,
    required this.onSelect,
  });

  final MobileCreationQuestion question;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          question.prompt,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
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
              onPressed: enabled ? () => onSelect('Skip this for now.') : null,
            ),
          ],
        ),
      ],
    );
  }
}

class _ChipRow extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: options.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final option = options[index];
          return ActionChip(
            avatar: Icon(icon, size: 18),
            label: Text(option),
            onPressed: enabled ? () => onSelect(option) : null,
          );
        },
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.enabled,
    required this.hasSourceNotes,
    required this.onAttachNotes,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final bool hasSourceNotes;
  final VoidCallback onAttachNotes;
  final ValueChanged<String> onSend;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        IconButton(
          tooltip: hasSourceNotes ? 'Source notes attached' : 'Attach source notes',
          onPressed: onAttachNotes,
          icon: Icon(
            hasSourceNotes ? Icons.attach_file : Icons.attach_file_outlined,
            color: hasSourceNotes ? colors.primary : null,
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
              hintText: 'Describe your book or answer above…',
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
                  onPressed: () =>
                      Navigator.of(context).pop(controller.text),
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
            _AdvancedGroup(
              title: 'Book type',
              yourChoice: state.userChoices.contains(CreationChoice.bookType),
              options: bookTypePresetOptions,
              selected: presets.bookType,
              onChanged: controller.setBookType,
            ),
            const SizedBox(height: 14),
            _AdvancedGroup(
              title: 'Length',
              yourChoice: state.userChoices.contains(CreationChoice.length),
              options: lengthPresetOptions(presets.bookType),
              selected: presets.lengthPreset,
              onChanged: controller.setLengthPreset,
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
    final known = creationLanguageOptions.any(
      (option) => option.code == language,
    );
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
            if (value != null) {
              onChanged(value);
            }
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

  static const _toneExamples = ['warm', 'funny', 'practical', 'polished', 'gentle'];

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
