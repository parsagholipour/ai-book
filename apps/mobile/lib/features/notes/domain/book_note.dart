/// A book's private notebook: what one note is, how a list of them is ordered
/// and searched, and the words a note shows before it is opened.
///
/// Notes are the owner's own — never printed, never exported, never sent to a
/// model. The wire contract is `.scratch/book-notes/spec.md`; the server's
/// twin of [BookNote] is `BookNoteDto` in `apps/api/src/mobile/bookNoteDto.ts`.
library;

/// The longest title the server keeps.
const bookNoteTitleLimit = 200;

/// The longest body the server keeps.
const bookNoteBodyLimit = 30000;

/// How many notes one book may hold.
const bookNotesPerBookLimit = 200;

/// What a note is called before it has a title or a first line.
const untitledBookNote = 'Untitled note';

/// One note: an optional title and a plain-text body.
class BookNote {
  const BookNote({
    required this.id,
    required this.title,
    required this.body,
    required this.pinned,
    required this.revision,
    required this.createdAt,
    required this.editedAt,
  });

  factory BookNote.fromJson(Map<String, dynamic> json) {
    final createdAt = _date(json['createdAt']);
    return BookNote(
      id: json['id'] as String,
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      pinned: json['pinned'] as bool? ?? false,
      revision: (json['revision'] as num?)?.toInt() ?? 1,
      createdAt: createdAt,
      editedAt: json['editedAt'] == null ? createdAt : _date(json['editedAt']),
    );
  }

  final String id;

  /// Empty when the note has no title.
  final String title;
  final String body;
  final bool pinned;

  /// Bumps on every title or body change, never on a pin. A text save sends
  /// the revision it started from, and the server refuses a stale one.
  final int revision;
  final DateTime createdAt;

  /// The last title or body change: what the list sorts by and shows.
  final DateTime editedAt;

  bool get isBlank => title.trim().isEmpty && body.trim().isEmpty;

  /// The note's title, or its first line, or [untitledBookNote].
  String get displayTitle => bookNoteDisplayTitle(title, body);

  /// A few lines of the body for a card: everything the display title does
  /// not already say.
  String get preview => bookNotePreview(title, body);

  /// What an Undo brings back.
  BookNoteDraft get draft => (title: title, body: body, pinned: pinned);

  BookNote copyWith({
    String? title,
    String? body,
    bool? pinned,
    int? revision,
    DateTime? editedAt,
  }) {
    return BookNote(
      id: id,
      title: title ?? this.title,
      body: body ?? this.body,
      pinned: pinned ?? this.pinned,
      revision: revision ?? this.revision,
      createdAt: createdAt,
      editedAt: editedAt ?? this.editedAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is BookNote &&
      other.id == id &&
      other.title == title &&
      other.body == body &&
      other.pinned == pinned &&
      other.revision == revision &&
      other.createdAt == createdAt &&
      other.editedAt == editedAt;

  @override
  int get hashCode =>
      Object.hash(id, title, body, pinned, revision, createdAt, editedAt);

  @override
  String toString() => 'BookNote($id, r$revision, "$displayTitle")';
}

/// The words of a note without its identity: what a delete's Undo writes
/// back as a new note.
typedef BookNoteDraft = ({String title, String body, bool pinned});

/// A text save refused because another device saved first. [note] is the
/// server's copy as it is now.
class BookNoteConflictException implements Exception {
  const BookNoteConflictException(this.note);

  final BookNote note;

  @override
  String toString() => 'BookNoteConflictException(${note.id})';
}

DateTime _date(Object? value) {
  final parsed = value is String ? DateTime.tryParse(value) : null;
  return parsed ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
}

final _spaces = RegExp(r'\s+');
final _blankLines = RegExp(r'\n[ \t]*(?:\n[ \t]*)+');

/// The first line of [text] with anything in it, trimmed, or null.
String? _firstLine(String text) {
  for (final line in text.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isNotEmpty) return trimmed;
  }
  return null;
}

String bookNoteDisplayTitle(String title, String body) {
  final named = title.trim().replaceAll(_spaces, ' ');
  if (named.isNotEmpty) return named;
  return _firstLine(body) ?? untitledBookNote;
}

/// Past this, a preview is cut: a card shows three lines at most, and laying
/// out a 30,000-character body to show three of them is wasted work.
const _previewLength = 280;

String bookNotePreview(String title, String body) {
  var text = body.trim();
  if (title.trim().isEmpty) {
    // The first line is already the card's title.
    final first = _firstLine(text);
    if (first != null) {
      final at = text.indexOf(first);
      text = text.substring(at + first.length).trim();
    }
  }
  text = text.replaceAll('\r', '').replaceAll(_blankLines, '\n');
  if (text.length > _previewLength) {
    text = '${_cut(text, _previewLength).trimRight()}…';
  }
  return text;
}

/// [text] cut to at most [length] UTF-16 units, never through a surrogate pair.
String _cut(String text, int length) {
  if (text.length <= length) return text;
  var end = length;
  final unit = text.codeUnitAt(end - 1);
  if (unit >= 0xD800 && unit <= 0xDBFF) end -= 1;
  return text.substring(0, end);
}

const _copySuffix = ' (this device)';

/// The title of the note a conflict saves this device's words into.
String bookNoteCopyTitle(String title, String body) {
  final base = bookNoteDisplayTitle(title, body);
  return '${_cut(base, bookNoteTitleLimit - _copySuffix.length).trimRight()}'
      '$_copySuffix';
}

int _compareNotes(BookNote a, BookNote b) {
  if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
  final edited = b.editedAt.compareTo(a.editedAt);
  if (edited != 0) return edited;
  final created = b.createdAt.compareTo(a.createdAt);
  if (created != 0) return created;
  return a.id.compareTo(b.id);
}

/// The server's order: pinned first, then most recently edited, then most
/// recently created.
List<BookNote> sortBookNotes(Iterable<BookNote> notes) =>
    notes.toList()..sort(_compareNotes);

/// The notes whose title or body holds every word of [query], in the order
/// they were given. Case is ignored; an empty query matches everything.
List<BookNote> searchBookNotes(List<BookNote> notes, String query) {
  final terms = query
      .toLowerCase()
      .split(_spaces)
      .where((term) => term.isNotEmpty)
      .toList();
  if (terms.isEmpty) return notes;
  return [
    for (final note in notes)
      if (_matches('${note.title}\n${note.body}'.toLowerCase(), terms)) note,
  ];
}

bool _matches(String haystack, List<String> terms) =>
    terms.every(haystack.contains);

/// A sorted list split into its pinned notes and the rest.
({List<BookNote> pinned, List<BookNote> others}) groupBookNotes(
  List<BookNote> sorted,
) {
  return (
    pinned: [
      for (final note in sorted)
        if (note.pinned) note,
    ],
    others: [
      for (final note in sorted)
        if (!note.pinned) note,
    ],
  );
}

/// The [count] most recently edited notes, pinned or not.
List<BookNote> recentBookNotes(List<BookNote> notes, {int count = 2}) {
  final byEdit = notes.toList()
    ..sort((a, b) {
      final edited = b.editedAt.compareTo(a.editedAt);
      return edited != 0 ? edited : b.createdAt.compareTo(a.createdAt);
    });
  return byEdit.take(count).toList();
}

int _requestSequence = 0;

/// A fresh idempotency key for one note create. The caller keeps it across
/// retries of the same create, so a POST that did land is answered, not
/// repeated.
String newBookNoteRequestId() {
  _requestSequence += 1;
  return 'note-${DateTime.now().microsecondsSinceEpoch}-$_requestSequence';
}
