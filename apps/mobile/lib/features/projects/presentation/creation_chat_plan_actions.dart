part of 'creation_chat_screen.dart';

// Plan preflight, revision, approval, and question progression remain methods
// on the screen state while living away from transcript composition.
extension _CreationChatPlanActions on _CreationChatScreenState {
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
        if (!await _CreationChatVisualsPrompt(
          this,
        ).confirmVisuals(presets, targetPages)) {
          return;
        }
        if (!mounted) return;
      }
      final result = await controller.buildPlan();
      ref.invalidate(projectsProvider);
      _refreshOutput(result.project.id);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      _updateState(() {
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
        _updateState(() => _planBusyAction = null);
        return;
      }
      _updateState(() {
        _planBusyAction = 'revise';
        _pendingRevisionPlanKey = _activePlanKey ?? _planKey(plan);
        _pendingRevisionOperationId = operation.id;
        _revisionController.clear();
      });
      _startPlanPoll();
    } catch (error) {
      if (!mounted) return;
      _updateState(() => _planBusyAction = null);
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
        if (mounted) _updateState(() => _planBusyAction = 'approve');
      },
      onSettled: () {
        if (mounted && _planBusyAction == 'approve') {
          _updateState(() => _planBusyAction = null);
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
      _updateState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  void _onPlanQuestionSkip(MobileProjectDetail project, MobilePlan plan) {
    final next = _planQuestionIndex + 1;
    if (next < plan.questions.length) {
      _updateState(() => _planQuestionIndex = next);
    } else {
      _maybeSendPlanAnswers(project, plan);
    }
  }

  Future<void> _maybeSendPlanAnswers(
    MobileProjectDetail project,
    MobilePlan plan,
  ) async {
    final answers = Map<int, String>.from(_planQuestionAnswers);
    _updateState(() {
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
}
