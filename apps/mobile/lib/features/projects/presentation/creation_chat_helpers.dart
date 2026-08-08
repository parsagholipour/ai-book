import '../domain/creation_models.dart';
import 'creation_chat_state.dart';

/// Pure helpers for [CreationChatController], split out to keep the controller
/// inside its size budget: the local greeting shown before the server answers,
/// output-list merging, and composer-chip reconciliation.

const creationChatLocalGreetingText =
    'Hi! Tell me about the book you want to make. Describe your idea in a sentence or two, or tap an example to start.';

const creationChatLocalGreetingTurn = MobileCreationTurn(
  assistantMessage: creationChatLocalGreetingText,
  brief: MobileBookRecipe(lane: 'auto'),
  presets: defaultCreationPresets,
  detectedLane: 'auto',
  quickReplies: <String>[
    'Bedtime story for 5 year olds',
    'Lead magnet about pricing',
    'Workbook for new coaches',
    'Short story about a garden mystery',
  ],
  readiness: emptyCreationReadiness,
  titleSuggestions: <String>[],
  shapePreview: <String>['Clear reader promise'],
  warnings: <String>[],
);

List<MobileCreationOutput> mergeCreationOutputsInto(
  List<MobileCreationOutput> current,
  Iterable<MobileCreationOutput> incoming,
) {
  final next = [...current];
  for (final output in incoming) {
    final index = next.indexWhere(
      (existing) => existing.projectId == output.projectId,
    );
    if (index == -1) {
      next.add(output);
    } else {
      next[index] = output;
    }
  }
  next.sort((a, b) => a.sequence.compareTo(b.sequence));
  return next;
}

/// Keeps composer chips in sync with the server: files uploaded but not yet
/// sent with a message reappear as ready chips (also across app restarts),
/// while local uploads still in flight are preserved.
List<PendingCreationAttachment> reconcilePendingCreationAttachments(
  MobileCreationSession session,
  List<PendingCreationAttachment> pendingAttachments,
) {
  final referencedIds = <String>{
    for (final message in session.messages)
      for (final attachment in message.attachments) attachment.id,
  };
  final serverIds = session.attachments
      .map((attachment) => attachment.id)
      .toSet();
  final localByServerId = <String, PendingCreationAttachment>{
    for (final pending in pendingAttachments)
      if (pending.attachment != null) pending.attachment!.id: pending,
  };
  return [
    for (final attachment in session.attachments)
      if (!referencedIds.contains(attachment.id))
        localByServerId[attachment.id] ??
            PendingCreationAttachment(
              localId: 'server_${attachment.id}',
              name: attachment.name,
              kind: attachment.kind,
              status: PendingAttachmentStatus.ready,
              attachment: attachment,
            ),
    // Local entries the server response does not know about yet: uploads in
    // flight, failures awaiting retry, and just-finished uploads racing a
    // stale response.
    for (final pending in pendingAttachments)
      if (pending.attachment == null ||
          (!serverIds.contains(pending.attachment!.id) &&
              !referencedIds.contains(pending.attachment!.id)))
        pending,
  ];
}
