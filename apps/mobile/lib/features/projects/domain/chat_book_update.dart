import 'project_models.dart';

/// What a book-chat reply that rebuilt the book says about the book, drawn
/// inside the reply itself (`ChatBookUpdateRow`).
///
/// A free change — the author name, the title, the Sources list, the chapter
/// headings, a page design — has no operation card, so its "Done" reply used
/// to be the last thing in the chat while the book was rebuilt, and nothing
/// said when the new book was in (Parsa, 2026-10-17: "so the user understands
/// the new book is ready"). The server marks such a reply with the revision the
/// rebuild was committed at (`bookUpdate.contentRevision`,
/// `apps/api/src/mobile/bookUpdateMetadata.ts`).
enum ChatBookUpdateState {
  /// The rebuild is still running, or the status has not caught up with it.
  updating,

  /// The book's PDF is the one with this change.
  ready,
}

/// The reply that carries the row: the last reply in the transcript, when it
/// is one that rebuilt the book. Only the last — an older reply's button would
/// sit above whatever the chat said since, and a later paid edit's card owns
/// the book's progress from then on.
MobileProjectChatMessage? chatBookUpdateMessage(
  List<MobileProjectChatMessage> messages,
) {
  for (final message in messages.reversed) {
    if (!message.isAssistant) continue;
    return message.bookUpdateRevision == null ? null : message;
  }
  return null;
}

/// Updating until a settled status reports the book at [revision] or later
/// with its PDF in; never ready on a status read before the change, which is
/// what the revision is for. Null while the book is in neither state (a failed
/// book), so the reply draws no row rather than a promise.
ChatBookUpdateState? chatBookUpdateState({
  required int revision,
  required MobileProjectStatus? status,
}) {
  if (status == null || status.isLive) return ChatBookUpdateState.updating;
  if (!status.isSettled) return null;
  final pdf = status.exports.pdf;
  return pdf.available && pdf.revision >= revision
      ? ChatBookUpdateState.ready
      : ChatBookUpdateState.updating;
}
