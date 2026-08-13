import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../domain/project_models.dart';
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
/// stored message ids belong to a branch the reader is no longer on.
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
    final operationId = message.operationId;
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

/// An [OperationBubble] wired to the routes its card can open.
class ProjectChatOperationBubble extends StatelessWidget {
  const ProjectChatOperationBubble({
    required this.projectId,
    required this.operation,
    required this.retrying,
    required this.undoing,
    this.onRetry,
    this.onUndo,
    super.key,
  });

  final String projectId;
  final MobileBookEditOperation operation;
  final bool retrying;
  final bool undoing;
  final VoidCallback? onRetry;
  final VoidCallback? onUndo;

  @override
  Widget build(BuildContext context) {
    final openAtPage = operation.affectedPageIndexes.isEmpty
        ? null
        : operation.affectedPageIndexes.reduce((a, b) => a < b ? a : b);
    return OperationBubble(
      operation: operation,
      retrying: retrying,
      undoing: undoing,
      onRetry: operation.isFailed ? onRetry : null,
      onUndo: operation.canUndo ? onUndo : null,
      onViewPlan: operation.isPlanRevision
          ? () => context.push('/projects/$projectId')
          : null,
      onOpenBook: operation.isApplied
          ? () => context.push(
              '/projects/$projectId/read'
              '${openAtPage == null ? '' : '?page=$openAtPage'}',
            )
          : null,
      // A failed edit keeps whatever snapshots it managed to write, but its card
      // is for getting the book back on track — Retry, not a diff.
      onSeeChanges: operation.isApplied && operation.changesAvailable
          ? () => context.push('/projects/$projectId/changes/${operation.id}')
          : null,
    );
  }
}
