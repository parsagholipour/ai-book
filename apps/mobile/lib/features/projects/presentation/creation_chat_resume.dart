part of 'creation_chat_screen.dart';

// Restarting work the server gave up on: a plan that failed to write, and a
// book whose writing stopped partway. Both are the same `resumeProject` call
// and both are offered where the failure is read, so they live together.
//
// Retrying a *request* the user made — a plan revision, an edit — is a
// different thing and stays in the screen with the rest of that state.
//
// A mixin rather than plain helpers because these need `setState`, `ref` and
// `mounted`.

mixin _CreationChatResume on ConsumerState<CreationChatScreen> {
  /// The retry currently in flight, so a stale one cannot clear the busy state
  /// a newer one owns.
  Object? _planRetryRequest;

  // Provided by the screen this mixin is applied to.
  String? get _planBusyAction;
  set _planBusyAction(String? value);
  void _refreshOutput(String projectId);
  void _startPlanPoll();
  String? _activeProjectId(CreationChatState state);

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

  /// Restarts a book whose writing failed, from the chat's progress bubble.
  ///
  /// The same `resumeProject` the book page's "Retry generation" calls — a
  /// failure read in the chat used to have its only fix one screen away.
  /// Restarting the poll is the part that is easy to miss: both it and the
  /// status stream stop themselves on `failed`, so nothing would notice the
  /// book moving again.
  Future<void> _retryBookGeneration(String projectId) async {
    try {
      final recovery = await ref
          .read(projectsRepositoryProvider)
          .resumeProject(projectId);
      if (!mounted) return;
      _refreshOutput(projectId);
      ref.invalidate(projectsProvider);
      _startPlanPoll();
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(recovery.currentAction)));
    } catch (error) {
      if (!mounted) return;
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
}
