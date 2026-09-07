import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'progress_step_row.dart';
import 'project_chat_bubbles.dart';

// Where an edit operation sits in the transcript, and what its card offers.

/// Operation cards placed against the transcript: [anchored] renders under the
/// message that produced it, [unanchored] falls back to the end of the list.
class TranscriptOperations {
  const TranscriptOperations({
    required this.anchored,
    required this.unanchored,
  });

  final Map<String, List<MobileBookEditOperation>> anchored;
  final List<MobileBookEditOperation> unanchored;

  List<MobileBookEditOperation> anchoredTo(String messageId) =>
      anchored[messageId] ?? const [];

  /// True when a card in this split is still in flight, so the transcript
  /// already has a place to draw live progress and the plan-side generation
  /// bubble must not tell the same story a second time.
  bool get hasRunning =>
      unanchored.any((operation) => operation.isRunning) ||
      anchored.values.any(
        (operations) => operations.any((operation) => operation.isRunning),
      );
}

/// Settled work, whose outcome the reader can act on. The creation chat widens
/// this to running work: that transcript has no separate progress card, so the
/// spinner lives on the operation card itself.
bool _isSettledOperation(MobileBookEditOperation operation) =>
    operation.isApplied || operation.isFailed;

/// Splits the operations worth showing into the ones that belong under a
/// visible message and the ones with nowhere else to go. [shows] decides which
/// operations are worth showing at all, defaulting to the settled ones.
///
/// Every applied and failed edit appears, each under the turn that produced it,
/// so the transcript reads as the book's history. Rendering them at the end of
/// the list instead put "Edit applied" and its credit charge underneath
/// whatever the user asked most recently — including a proposal still waiting
/// on Apply, which read as if that proposal had gone through and been billed.
///
/// The reply's own `operationId` outranks `anchorMessageId`, because the server
/// writes the operation row, then the reply announcing it, then stamps the
/// reply back onto the row — so a transcript read inside that window carries an
/// anchor still pointing at the user's message, and the card would render above
/// the sentence introducing it. The same preference re-homes an operation whose
/// stored message ids belong to a branch the reader is no longer on — and an
/// Undo/Redo reply that stamps the restored operation, so Open book sits on
/// that latest turn rather than the original Apply. Wire `operationId` outranks
/// [MobileProjectChatMessage.undoRedoOperationId]; the metadata id is the
/// fallback for replies written before that column was stamped.
TranscriptOperations splitTranscriptOperations({
  required List<MobileBookEditOperation> operations,
  required List<MobileProjectChatMessage> messages,
  bool Function(MobileBookEditOperation operation)? shows,
}) {
  final showsOperation = shows ?? _isSettledOperation;
  final visibleMessageIds = <String>{};
  final replyForOperation = <String, String>{};
  for (final message in messages) {
    visibleMessageIds.add(message.id);
    final operationId = message.operationId ?? message.undoRedoOperationId;
    // Last one wins: a replayed Apply writes a second reply about the same
    // operation, and the card belongs under the turn the reader is looking at.
    if (operationId != null && operationId.isNotEmpty) {
      replyForOperation[operationId] = message.id;
    }
  }
  final anchored = <String, List<MobileBookEditOperation>>{};
  final unanchored = <MobileBookEditOperation>[];
  for (final operation in operations) {
    if (!showsOperation(operation)) {
      continue;
    }
    final stored = operation.anchorMessageId;
    final anchor =
        replyForOperation[operation.id] ??
        (stored != null && visibleMessageIds.contains(stored) ? stored : null);
    if (anchor != null) {
      (anchored[anchor] ??= []).add(operation);
      continue;
    }
    // Nowhere to sit in the transcript. Only the most recent couple are worth
    // stacking at the end; older ones would be history without its context.
    if (unanchored.length < 2) {
      unanchored.add(operation);
    }
  }
  return TranscriptOperations(anchored: anchored, unanchored: unanchored);
}

/// The operation whose Undo/Redo compile is still in flight, if any.
///
/// [localRebuildOperationId] covers the frames before the transcript refresh
/// carries the reply; the latest undo/redo message is the durable source.
String? transcriptRebuildOperationId({
  required List<MobileProjectChatMessage> messages,
  String? localRebuildOperationId,
}) {
  final local = localRebuildOperationId?.trim();
  if (local != null && local.isNotEmpty) return local;
  for (var index = messages.length - 1; index >= 0; index--) {
    final message = messages[index];
    if (!message.queuedRebuildAfterUndoRedo) continue;
    final id = message.operationId ?? message.undoRedoOperationId;
    if (id != null && id.isNotEmpty) return id;
  }
  return null;
}

bool undoRedoRebuildInFlight({
  required String? rebuildOperationId,
  required bool awaitingRebuild,
  required bool liveEditing,
}) {
  return rebuildOperationId != null &&
      rebuildOperationId.isNotEmpty &&
      (awaitingRebuild || liveEditing);
}

/// The Undo/Redo compile currently painting on a card, if any.
///
/// [operationId] and [inFlight] always travel together: a card is rebuilding
/// only when both the id matches and the compile is still live.
class UndoRedoRebuildView {
  const UndoRedoRebuildView({
    required this.operationId,
    required this.inFlight,
  });

  final String? operationId;
  final bool inFlight;

  bool isRebuilding(String operationId) =>
      inFlight && this.operationId == operationId;
}

/// Builds [UndoRedoRebuildView] from the transcript and the local handoff.
UndoRedoRebuildView undoRedoRebuildView({
  required List<MobileProjectChatMessage> messages,
  String? localRebuildOperationId,
  required bool awaitingRebuild,
  required bool liveEditing,
}) {
  final operationId = transcriptRebuildOperationId(
    messages: messages,
    localRebuildOperationId: localRebuildOperationId,
  );
  return UndoRedoRebuildView(
    operationId: operationId,
    inFlight: undoRedoRebuildInFlight(
      rebuildOperationId: operationId,
      awaitingRebuild: awaitingRebuild,
      liveEditing: liveEditing,
    ),
  );
}

/// Local Undo/Redo compile handoff: armed from the send result, cleared when a
/// status tick is a new PDF rather than the pre-undo snapshot.
///
/// Both chats hold one instance and wrap [shouldSettle] / [clear] in their own
/// setState (creation also defers that to a post-frame callback). Not a
/// ChangeNotifier — the screens already own rebuild.
class UndoRedoRebuildHandoff {
  bool awaiting = false;
  String? operationId;

  /// Pre-Undo/Redo COMPLETE snapshot captured at [arm].
  MobileProjectStatus? statusBeforeRebuild;

  bool get inFlight => awaiting || operationId != null;

  void arm(
    MobileProjectChatSendResult result, {
    MobileProjectStatus? currentStatus,
  }) {
    final queued = result.reply.queuedRebuildAfterUndoRedo;
    awaiting = queued;
    if (!queued) {
      operationId = null;
      statusBeforeRebuild = null;
      return;
    }
    statusBeforeRebuild = currentStatus;
    final id = result.reply.operationId ?? result.reply.undoRedoOperationId;
    if (id != null && id.isNotEmpty) {
      operationId = id;
    }
  }

  void clear() {
    awaiting = false;
    operationId = null;
    statusBeforeRebuild = null;
  }

  /// Whether this tick should end the rebuild (new PDF). Live ticks and the
  /// pre-undo COMPLETE snapshot (identity or same updatedAt) are not that.
  bool shouldSettle(MobileProjectStatus status) {
    if (!inFlight) return false;
    if (status.isLive) return false;
    final snapshot = statusBeforeRebuild;
    if (identical(status, snapshot)) return false;
    if (snapshot != null && status.updatedAt == snapshot.updatedAt) {
      return false;
    }
    return true;
  }
}

/// An [OperationBubble] wired to the routes its card can open.
class ProjectChatOperationBubble extends StatelessWidget {
  const ProjectChatOperationBubble({
    required this.projectId,
    required this.operation,
    required this.retrying,
    required this.undoing,
    this.redoing = false,
    this.rebuilding = false,
    this.liveStatus,
    this.onRetry,
    this.onUndo,
    this.onRedo,
    super.key,
  });

  final String projectId;
  final MobileBookEditOperation operation;
  final bool retrying;
  final bool undoing;
  final bool redoing;

  /// The free Undo/Redo compile is still running, so this applied card must
  /// not offer Open book against the previous PDF.
  final bool rebuilding;

  /// The project's live status, used only while [operation] is still running
  /// so the card can name the page and step the worker is on right now.
  final MobileProjectStatus? liveStatus;
  final VoidCallback? onRetry;
  final VoidCallback? onUndo;
  final VoidCallback? onRedo;

  @override
  Widget build(BuildContext context) {
    final openAtPage = operation.affectedPageIndexes.isEmpty
        ? null
        : operation.affectedPageIndexes.reduce((a, b) => a < b ? a : b);
    final settled = operation.isApplied && !rebuilding;
    return OperationBubble(
      operation: operation,
      retrying: retrying,
      undoing: undoing,
      redoing: redoing,
      rebuilding: rebuilding,
      liveProgress: _liveEditProgress(
        operation: operation,
        status: liveStatus,
        rebuilding: rebuilding,
      ),
      onRetry: operation.isFailed ? onRetry : null,
      onUndo: operation.isApplied && operation.canUndo ? onUndo : null,
      onRedo: operation.isApplied && operation.canRedo ? onRedo : null,
      onViewPlan: operation.isPlanRevision
          ? () => context.push('/projects/$projectId')
          : null,
      onOpenBook: settled
          ? () => context.push(
              '/projects/$projectId/read'
              '${openAtPage == null ? '' : '?page=$openAtPage'}',
            )
          : null,
      // A failed edit keeps whatever snapshots it managed to write, but its card
      // is for getting the book back on track — Retry, not a diff. Snapshots
      // already exist once applied, so the diff stays offered during rebuild.
      onSeeChanges: operation.isApplied && operation.changesAvailable
          ? () => context.push('/projects/$projectId/changes/${operation.id}')
          : null,
    );
  }
}

Widget? _liveEditProgress({
  required MobileBookEditOperation operation,
  required MobileProjectStatus? status,
  required bool rebuilding,
}) {
  // Applied Undo/Redo rebuilds the PDF without a running operation; the
  // thinking bubble used to sit at the end of the transcript instead. Same
  // layout as a live edit, with a fallback step until the stream names one.
  if (rebuilding || (operation.isRunning && status?.editProgress != null)) {
    return LiveEditOperationProgress(
      // Remount once the stream names steps so AppSwitcher does not keep the
      // pre-tick "Rebuilding your book…" label in the tree during the fade.
      key: ValueKey(status?.editProgress != null),
      status: status,
      overallAction: operation.displayAction,
    );
  }
  return null;
}

/// The export milestone the server reports once an edit's compile is live.
/// Used as the sole step until [MobileProjectStatus.editProgress] arrives.
const _rebuildExportStep = MobileProjectStatusStep(
  key: 'export',
  label: 'Rebuilding your book',
  status: 'active',
);

/// Bar, percent, current page, and the edit's own steps on a running card.
///
/// The creation chat has no separate progress bubble for a finished-book edit
/// — the spinner used to sit on this card next to a frozen "Rewriting 11
/// pages." until the job settled. The status stream already names the page
/// and phase; this is what draws them.
///
/// An Undo/Redo compile can be in flight before [status] carries
/// [MobileProjectStatus.editProgress]; the bar then sits at 0% with the
/// export step active until the stream names a page. A non-live status's
/// [MobileProjectStatus.progressPercent] is the previous book, not this rebuild.
class LiveEditOperationProgress extends StatefulWidget {
  const LiveEditOperationProgress({
    required this.status,
    required this.overallAction,
    super.key,
  });

  final MobileProjectStatus? status;
  final String overallAction;

  @override
  State<LiveEditOperationProgress> createState() =>
      _LiveEditOperationProgressState();
}

class _LiveEditOperationProgressState extends State<LiveEditOperationProgress> {
  int _shownPercent = 0;
  String? _shownStatus;

  int _monotonicPercent(String phase, int next) {
    if (phase != _shownStatus) {
      _shownStatus = phase;
      _shownPercent = next;
      return _shownPercent;
    }
    if (next > _shownPercent) {
      _shownPercent = next;
    }
    return _shownPercent;
  }

  @override
  Widget build(BuildContext context) {
    final status = widget.status;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final progress = status?.editProgress;
    final percent = _monotonicPercent(
      status?.status ?? 'rebuild',
      (progress?.percent ??
              (status != null && status.isLive ? status.progressPercent : 0))
          .clamp(0, 100)
          .toInt(),
    );
    final named = (progress?.detail ?? status?.currentAction)?.trim() ?? '';
    final current = named.isNotEmpty
        ? named
        : progress == null
        ? 'Rebuilding your book…'
        : '';
    final overall = widget.overallAction.trim().replaceAll(RegExp(r'\.+$'), '');
    final currentBare = current.replaceAll(RegExp(r'\.+$'), '');
    final showCurrent = current.isNotEmpty && currentBare != overall;
    final steps = progress?.steps ?? const [_rebuildExportStep];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: showCurrent
                  ? AppSwitcher(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        current,
                        key: ValueKey(current),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSecondaryContainer,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            AppAnimatedCount(
              value: percent,
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSecondaryContainer,
                fontWeight: FontWeight.w700,
              ),
              builder: (value) => '$value%',
            ),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: AppAnimatedProgressBar(
            value: percent / 100,
            semanticLabel: showCurrent ? current : widget.overallAction,
          ),
        ),
        if (steps.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final step in steps)
            ProgressStepRow(step: step, showDetail: true),
        ],
      ],
    );
  }
}
