/**
 * What a book-chat reply carries when it queued a free rebuild of the finished
 * book — a matter, title, Sources-list, chapter-heading, page-design or
 * Tomeza-credit change, none of which has an operation card to say when the new
 * PDF is in. The app draws the reply's own book row from it
 * (`MobileProjectChatMessage.bookUpdate`, apps/mobile): "Updating your book…"
 * while the status is behind this revision or still live, then Open book.
 *
 * The revision is the one the rebuild was committed at, so a status read before
 * the change — a stream that has not caught up — never offers the old PDF as the
 * new one. Asked for by Parsa on 2026-10-17, after a matter edit's "Done" reply
 * left nothing in the chat to show the book had been rebuilt.
 */
export function bookUpdateMetadata(contentRevision: number | undefined): { bookUpdate?: { contentRevision: number } } {
  return contentRevision === undefined ? {} : { bookUpdate: { contentRevision } };
}
