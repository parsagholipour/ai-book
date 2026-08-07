part of 'creation_chat_screen.dart';

// Keeping the screen honest about work the server is still doing.
//
// The status stream carries the *progress* of a live book, and nothing else:
// not the plan, not the chat, not the finished pages. Those only arrive when
// `projectDetailProvider` and `projectChatProvider` are re-fetched, so
// something has to notice that a book is being worked on and keep asking.
//
// That used to be armed only by local actions — build, approve, apply, retry —
// which meant a project the screen *arrived at* rather than started, like the
// revised copy a whole-book replan creates, was fetched once while it was still
// empty and never again. The plan footer sat on "Creating your book plan" for
// the whole generation and then kept sitting there after the book was finished.
//
// So the poll follows the book's liveness instead, the way `book_screen.dart`
// already does it, and the falling edge does one last refresh.
//
// A mixin rather than plain helpers because these need `setState`, `ref` and
// `mounted`.

mixin _LiveOutputRefresh on ConsumerState<CreationChatScreen> {
  Timer? _planRefreshTimer;

  /// The project `_wasLive` is remembering, so switching outputs cannot inherit
  /// the previous one's edge and fire a completion refresh for a book the
  /// screen is no longer showing.
  String? _liveEdgeProjectId;
  bool _wasLive = false;

  // Provided by the screen this mixin is applied to.
  String? get _planBusyAction;
  set _planBusyAction(String? value);
  String? get _pendingRevisionPlanKey;
  set _pendingRevisionPlanKey(String? value);
  String? get _pendingRevisionOperationId;
  set _pendingRevisionOperationId(String? value);
  void _refreshOutput(String projectId, {bool refreshStatus});
  String? _activeProjectId(CreationChatState state);

  /// Starts polling while the book is live, and refreshes once when it stops.
  ///
  /// Called from `build` with whatever the status stream currently holds, so it
  /// has to be safe to run many times per second and must not touch a provider
  /// synchronously — hence the post-frame callback on the completion refresh.
  void _syncLivePolling(
    String projectId,
    AsyncValue<MobileProjectStatus> statusValue,
  ) {
    if (_liveEdgeProjectId != projectId) {
      _liveEdgeProjectId = projectId;
      _wasLive = false;
    }
    // `value` rather than `asData`: a refreshing provider still holds the last
    // status, and a book does not stop being live because a fetch is in flight.
    final live = statusValue.value?.isLive ?? false;
    if (live) {
      _wasLive = true;
      _startPlanPoll();
      return;
    }
    if (!_wasLive) return;
    _wasLive = false;
    _planRefreshTimer?.cancel();
    _planRefreshTimer = null;
    // The stream closes the moment the book settles, so this is the only
    // notice the screen gets that the plan, the pages and the exports are
    // there to be read.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _liveEdgeProjectId != projectId) return;
      _refreshOutput(projectId, refreshStatus: false);
    });
  }

  /// Re-reads the active output every few seconds while something is running.
  ///
  /// Kept callable directly by the actions that *start* work, so the first
  /// refresh does not wait for a status tick to arrive.
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
