import 'matter_changes.dart';

/// Server limits for one book's matter, mirrored from the book-matter route,
/// in UTF-16 code units (Dart's `String.length`, and what zod counts).
abstract final class BookMatterLimits {
  static const authorName = 120;
  static const dedication = 2000;
  static const aboutAuthor = 1500;
  static const authorWebsite = 200;
  static const copyrightHolder = 160;
  static const imprint = 120;
  static const isbn = 24;
}

/// A leading "ISBN", "ISBN-13:", "isbn 10 #" … label in front of an ISBN.
///
/// The same pattern as `withoutIsbnLabel` in
/// `apps/api/src/mobile/bookMatterEdits.ts`, which takes the label off before
/// [BookMatterLimits.isbn] is counted, because the copyright page prints
/// "ISBN" itself. The two have to move together. The group is the label's
/// 10 or 13, captured here only so [typedIsbnLabelLength] can tell a
/// finished label from one still being typed.
final _isbnLabel = RegExp(
  r'^\s*isbn([-\s]?1[03](?!\d))?\s*[:#]?\s*',
  caseSensitive: false,
);

final _startsWithDigit = RegExp(r'^\p{Nd}', unicode: true);

// The decimal-digit blocks core's normalizeNumerals accepts. Folding them
// keeps UTF-16 offsets, so the label is read in ASCII and removed from the
// original value without changing any printed digit or separator.
const _isbnNumeralBlockStarts = [
  0x0660,
  0x06f0,
  0x0966,
  0x09e6,
  0x0e50,
  0xff10,
];
final _isbnNativeNumerals = RegExp('[٠-٩۰-۹०-९০-৯๐-๙０-９]');

String _isbnLabelText(String text) =>
    text.replaceAllMapped(_isbnNativeNumerals, (match) {
      final code = match[0]!.codeUnitAt(0);
      final start = _isbnNumeralBlockStarts.firstWhere(
        (block) => code >= block && code <= block + 9,
      );
      return String.fromCharCode(0x30 + code - start);
    });

/// [isbn] the way the server counts and stores it: without a leading label,
/// unless the label is all there is (then the server keeps it and refuses
/// it as `INVALID_ISBN`).
String isbnWithoutLabel(String isbn) {
  final label = _isbnLabel.firstMatch(_isbnLabelText(isbn));
  if (label == null || label.end == isbn.length) return isbn;
  return isbn.substring(label.end);
}

/// How many leading code units of [text] are a label that can come off as
/// the reader types or pastes: one the number has started after, as in
/// "ISBN 9…" or "ISBN-13: 9…". Zero while the label may still be growing
/// ("ISBN 1" can be "ISBN 13" on its way), when nothing follows it yet, and
/// when what follows is not a number ("ISBN hello" stays as typed, for the
/// server to refuse in its own words).
int typedIsbnLabelLength(String text) {
  final normalized = _isbnLabelText(text);
  final label = _isbnLabel.firstMatch(normalized);
  if (label == null || label.end == text.length) return 0;
  final number = normalized.substring(label.end);
  if (!_startsWithDigit.hasMatch(number)) return 0;
  if (label.group(1) == null && number.startsWith('1')) return 0;
  return label.end;
}

/// One book's own copy of its title-page credits and matter pages —
/// `GET /api/mobile/projects/:id/book-matter`.
///
/// It starts as a copy of the author profile and is changed here, book by
/// book. See `.scratch/book-matter/spec.md`.
class BookMatter {
  const BookMatter({
    this.authorName,
    this.dedication,
    this.aboutAuthor,
    this.authorWebsite,
    this.copyrightHolder,
    this.imprint,
    this.isbn,
    this.allRightsReserved = false,
    this.madeWithCredit = false,
    this.creditPrinted = false,
    this.studioOwned = false,
  });

  final String? authorName;
  final String? dedication;

  /// The About the author page. Empty leaves the page out of the book.
  final String? aboutAuthor;
  final String? authorWebsite;
  final String? copyrightHolder;
  final String? imprint;
  final String? isbn;
  final bool allRightsReserved;

  /// The owner is on the free tier, so the copyright page carries a small
  /// "Made with Tomeza" line. Decided by the server at compile time.
  final bool madeWithCredit;

  /// The book's published files carry that line now — printed while the
  /// owner was on the free tier. A subscriber can take it off, free. An older
  /// server never sends it, which reads as false: nothing to offer.
  final bool creditPrinted;

  /// An author's own book: its author name and dedication are set in the
  /// Writing Studio's book settings, and this route refuses them.
  final bool studioOwned;

  factory BookMatter.fromJson(Map<String, dynamic> json) {
    return BookMatter(
      authorName: json['authorName'] as String?,
      dedication: json['dedication'] as String?,
      aboutAuthor: json['aboutAuthor'] as String?,
      authorWebsite: json['authorWebsite'] as String?,
      copyrightHolder: json['copyrightHolder'] as String?,
      imprint: json['imprint'] as String?,
      isbn: json['isbn'] as String?,
      allRightsReserved: json['allRightsReserved'] as bool? ?? false,
      madeWithCredit: json['madeWithCredit'] as bool? ?? false,
      creditPrinted: json['creditPrinted'] as bool? ?? false,
      studioOwned: json['studioOwned'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
    'authorName': authorName,
    'dedication': dedication,
    'aboutAuthor': aboutAuthor,
    'authorWebsite': authorWebsite,
    'copyrightHolder': copyrightHolder,
    'imprint': imprint,
    'isbn': isbn,
    'allRightsReserved': allRightsReserved,
    'madeWithCredit': madeWithCredit,
    'creditPrinted': creditPrinted,
    'studioOwned': studioOwned,
  };
}

/// A partial `PATCH /api/mobile/projects/:id/book-matter` body: only the keys
/// present are sent, and a key in [clear] is sent as null.
class BookMatterUpdate {
  const BookMatterUpdate({
    this.authorName,
    this.dedication,
    this.aboutAuthor,
    this.authorWebsite,
    this.copyrightHolder,
    this.imprint,
    this.isbn,
    this.allRightsReserved,
    this.clear = const {},
  });

  final String? authorName;
  final String? dedication;
  final String? aboutAuthor;
  final String? authorWebsite;
  final String? copyrightHolder;
  final String? imprint;
  final String? isbn;
  final bool? allRightsReserved;

  /// Wire names of the text fields to empty.
  final Set<String> clear;

  bool get isEmpty => toJson().isEmpty;

  Map<String, Object?> toJson() => {
    'authorName': ?authorName,
    'dedication': ?dedication,
    'aboutAuthor': ?aboutAuthor,
    'authorWebsite': ?authorWebsite,
    'copyrightHolder': ?copyrightHolder,
    'imprint': ?imprint,
    'isbn': ?isbn,
    'allRightsReserved': ?allRightsReserved,
    for (final field in clear) field: null,
  };
}

/// What a saved change does to the book's files.
enum BookMatterReprint {
  /// A settled book: its files are being made again, at no charge.
  queued,

  /// The book is still being written; the change is in it when it finishes.
  nextCompile,

  /// Nothing changed.
  none;

  static BookMatterReprint fromWire(String? wire) => switch (wire) {
    'queued' => queued,
    'next_compile' => nextCompile,
    _ => none,
  };
}

/// What a saved change does to the cover's words.
enum BookMatterCover {
  /// The cover is set again with the new name.
  retypeset,
  unchanged,

  /// The cover was drawn before covers kept their artwork apart from their
  /// words, so it keeps the name it was drawn with.
  keepsOldName;

  static BookMatterCover fromWire(String? wire) => switch (wire) {
    'retypeset' => retypeset,
    'keeps_old_name' => keepsOldName,
    _ => unchanged,
  };
}

/// The answer to a book-matter save.
class BookMatterSaved {
  const BookMatterSaved({
    required this.bookMatter,
    this.reprint = BookMatterReprint.none,
    this.cover = BookMatterCover.unchanged,
  });

  final BookMatter bookMatter;
  final BookMatterReprint reprint;
  final BookMatterCover cover;

  factory BookMatterSaved.fromJson(Map<String, dynamic> json) {
    return BookMatterSaved(
      bookMatter: BookMatter.fromJson(
        json['bookMatter'] as Map<String, dynamic>,
      ),
      reprint: BookMatterReprint.fromWire(json['reprint'] as String?),
      cover: BookMatterCover.fromWire(json['cover'] as String?),
    );
  }

  /// One or two sentences saying where the change will show, for the
  /// confirmation after a save.
  String get message {
    final cover = this.cover == BookMatterCover.retypeset;
    final parts = <String>[
      switch (reprint) {
        BookMatterReprint.queued =>
          cover
              ? 'Saved. Your book’s files and cover are being refreshed, at '
                    'no charge.'
              : 'Saved. Your book’s files are being refreshed, at no charge.',
        BookMatterReprint.nextCompile =>
          cover
              ? 'Saved. It will be in your book, cover included, when it '
                    'finishes.'
              : 'Saved. It will be in your book when it finishes.',
        BookMatterReprint.none => 'Saved.',
      },
      if (this.cover == BookMatterCover.keepsOldName)
        'Your cover was drawn before names could be re-set, so it keeps the '
            'old name.',
    ];
    return parts.join(' ');
  }
}

/// The answer to `POST /api/mobile/projects/:id/book-matter/remove-credit`.
class BookMatterCreditRemoval {
  const BookMatterCreditRemoval({
    required this.bookMatter,
    this.reprint = BookMatterReprint.none,
  });

  final BookMatter bookMatter;

  /// `queued`: the files are being made again without the line, free.
  /// `none`: they already carry no line.
  final BookMatterReprint reprint;

  factory BookMatterCreditRemoval.fromJson(Map<String, dynamic> json) {
    return BookMatterCreditRemoval(
      bookMatter: BookMatter.fromJson(
        json['bookMatter'] as Map<String, dynamic>,
      ),
      reprint: BookMatterReprint.fromWire(json['reprint'] as String?),
    );
  }

  /// What the book page says once the sheet is out of the way.
  String get message => switch (reprint) {
    BookMatterReprint.queued =>
      'Removing “Made with Tomeza”. Your book’s files are being refreshed, '
          'at no charge.',
    BookMatterReprint.nextCompile =>
      '“Made with Tomeza” won’t be in your book when it finishes.',
    BookMatterReprint.none =>
      '“Made with Tomeza” is already gone from this book’s files.',
  };

  /// What the sheet's credit line says in its own place, under its heading.
  String get sheetNote => switch (reprint) {
    BookMatterReprint.queued =>
      'Removed. This book’s files are being refreshed without it, at no '
          'charge.',
    _ => message,
  };
}

/// What the author changed in a book's Title & credits sheet, as a partial
/// update, or null when nothing did.
///
/// [authorName] and [dedication] are null when the sheet does not offer them
/// (a Studio book sets them in its own settings), and are then never sent.
BookMatterUpdate? bookMatterChanges(
  BookMatter original, {
  String? authorName,
  String? dedication,
  required String aboutAuthor,
  required String authorWebsite,
  required String copyrightHolder,
  required String imprint,
  required String isbn,
  required bool allRightsReserved,
}) {
  final changes = MatterChanges();
  final update = BookMatterUpdate(
    authorName: authorName == null
        ? null
        : changes.text('authorName', original.authorName, authorName),
    dedication: dedication == null
        ? null
        : changes.text('dedication', original.dedication, dedication),
    aboutAuthor: changes.text('aboutAuthor', original.aboutAuthor, aboutAuthor),
    authorWebsite: changes.text(
      'authorWebsite',
      original.authorWebsite,
      authorWebsite,
    ),
    copyrightHolder: changes.text(
      'copyrightHolder',
      original.copyrightHolder,
      copyrightHolder,
    ),
    imprint: changes.text('imprint', original.imprint, imprint),
    isbn: changes.text('isbn', original.isbn, isbn),
    allRightsReserved: changes.flag(
      original.allRightsReserved,
      allRightsReserved,
    ),
    clear: changes.cleared,
  );
  return update.isEmpty ? null : update;
}
