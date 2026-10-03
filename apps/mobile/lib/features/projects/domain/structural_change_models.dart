// How a proposed edit changes which pages the book has: the card's structural
// block and where its pages land.
//
// Split out of project_chat_models.dart, which re-exports this file so every
// screen that reads an edit proposal keeps seeing these types.

/// Where a structural edit puts its pages.
///
/// The server resolves this once — `structuralPlacementOf` in
/// `apps/api/src/mobile/structuralPageEdits.ts` — and the card's own sentence is
/// written from the same answer, so the summary and the chip under it cannot
/// name different places. They once could: both wire fields were sent for an
/// insert only, so a move's chip named no destination while the sentence above
/// it did.
enum MobileStructuralPlacement {
  /// The pages open the book. Model page 0 is not a page, so there is no printed
  /// number to send and the server marks it instead.
  front,

  /// After [MobileEditStructuralChange.afterReaderPage], in printed numbering.
  after,

  /// Before [MobileEditStructuralChange.beforeReaderPage]: on a book of short
  /// pages the gap can sit inside one sheet, and naming it by the page that
  /// begins there reads the way "move page 6 before page 4" was asked.
  before,

  /// The request named no place at all, which an insert appends.
  end,

  /// Nowhere this card may name: a delete carries its pages away and puts them
  /// nowhere, and an anchor the page map cannot place — a page some earlier edit
  /// added before this book's recompile published — is left out rather than
  /// approximated, because a model index reads as a printed page and names a
  /// different sheet.
  unnamed,
}

/// How a proposed edit changes which pages the book has.
///
/// Present only for `restructure_pages`, whose [MobileEditProposal
/// .affectedPageIndexes] is deliberately empty — the pages an insert creates do
/// not exist yet, so there are no indexes to name until the worker has run.
class MobileEditStructuralChange {
  const MobileEditStructuralChange({
    required this.action,
    required this.pageCount,
    required this.totalPages,
    required this.placement,
    this.afterReaderPage,
    this.beforeReaderPage,
    this.readerPageNumbers = const [],
  });

  /// `insert`, `delete` or `move`.
  final String action;
  final int pageCount;

  /// How long the book will be once this is applied.
  final int totalPages;

  /// Where the pages land — the whole of what this card may say about it.
  final MobileStructuralPlacement placement;

  /// The printed page the pages follow. Set exactly when [placement] is
  /// [MobileStructuralPlacement.after], which is the only reading of it: the
  /// wire's `atFrontOfBook` marker is folded into [placement] at parse time
  /// rather than kept beside it, so nothing in the app can read one and draw
  /// the other.
  final int? afterReaderPage;

  /// The printed page the pages precede, set when [placement] is
  /// [MobileStructuralPlacement.before].
  final int? beforeReaderPage;

  /// The printed pages a delete or a move covers.
  final List<int> readerPageNumbers;

  static MobileEditStructuralChange? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final action = json['action'] as String?;
    if (action == null || action.isEmpty) return null;
    final readerPages = json['readerPageNumbers'] as List<dynamic>? ?? const [];
    final afterReaderPage = json['afterReaderPage'] as int?;
    final beforeReaderPage = json['beforeReaderPage'] as int?;
    final atFrontOfBook = json['atFrontOfBook'] as bool? ?? false;
    return MobileEditStructuralChange(
      action: action,
      pageCount: json['pageCount'] as int? ?? 0,
      totalPages: json['totalPages'] as int? ?? 0,
      placement: _placementFrom(
        json['placement'],
        action: action,
        afterReaderPage: afterReaderPage,
        beforeReaderPage: beforeReaderPage,
        atFrontOfBook: atFrontOfBook,
      ),
      afterReaderPage: afterReaderPage,
      beforeReaderPage: beforeReaderPage,
      readerPageNumbers: readerPages.whereType<int>().toList(growable: false),
    );
  }

  /// The placement the server named, or the one its older cards implied.
  ///
  /// Proposals are stored on the chat message and re-served with the transcript,
  /// so cards written before the server sent a `placement` outlive the change
  /// that added it. Those carry the marker and the anchor number alone, and the
  /// reading below is the one this label always applied to them: a front marker,
  /// then a number, then — for an insert only — the append that a card naming
  /// neither has always meant. A move with neither named nowhere it could say.
  static MobileStructuralPlacement _placementFrom(
    Object? value, {
    required String action,
    required int? afterReaderPage,
    required int? beforeReaderPage,
    required bool atFrontOfBook,
  }) {
    if (value == 'front') return MobileStructuralPlacement.front;
    if (value == 'before' && beforeReaderPage != null) {
      return MobileStructuralPlacement.before;
    }
    if (value == 'end') return MobileStructuralPlacement.end;
    if (value == 'unnamed') return MobileStructuralPlacement.unnamed;
    // `after` without a page to name is not a destination, so it degrades to
    // saying nothing rather than to printing "page null".
    if (value == 'after') {
      return afterReaderPage == null
          ? MobileStructuralPlacement.unnamed
          : MobileStructuralPlacement.after;
    }
    if (atFrontOfBook) return MobileStructuralPlacement.front;
    if (afterReaderPage != null) return MobileStructuralPlacement.after;
    return action == 'insert'
        ? MobileStructuralPlacement.end
        : MobileStructuralPlacement.unnamed;
  }
}
