import '../../sharing/domain/book_remix.dart';
import 'creation_models.dart';

/// How a new book relates to one of the reader's finished books: the next
/// book of its story, a new story in its world, or a story of its own. The
/// server's wire words (`apps/api/src/mobile/creationSeries.ts`, core
/// `SERIES_CHOICE_MODES`) are a contract with installed builds.
enum BookSeriesMode {
  continuation('continuation'),
  inspired('inspired'),
  standalone('standalone');

  const BookSeriesMode(this.wire);

  final String wire;

  /// An answer this build does not know is no answer, so a newer server's
  /// mode never reads as one this build would draw wrongly.
  static BookSeriesMode? fromWire(Object? value) {
    for (final mode in values) {
      if (mode.wire == value) return mode;
    }
    return null;
  }

  bool get linksBook => this != BookSeriesMode.standalone;
}

/// A finished book the chat's @-mentioned characters already appear in.
class MobileCreationSeriesBook {
  const MobileCreationSeriesBook({
    required this.projectId,
    required this.title,
    this.characterNames = const [],
  });

  final String projectId;
  final String title;

  /// The mentioned characters this book already has, as the book spelled them.
  final List<String> characterNames;

  static MobileCreationSeriesBook? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final projectId = json['projectId'];
    final title = json['title'];
    if (projectId is! String || projectId.isEmpty || title is! String) {
      return null;
    }
    final names = json['characterNames'];
    return MobileCreationSeriesBook(
      projectId: projectId,
      title: title,
      characterNames: names is List
          ? names.whereType<String>().toList(growable: false)
          : const [],
    );
  }
}

/// What the reader answered about the series offer.
class MobileCreationSeriesChoice {
  const MobileCreationSeriesChoice({
    required this.mode,
    this.projectId,
    this.title,
  });

  final BookSeriesMode mode;
  final String? projectId;
  final String? title;

  static MobileCreationSeriesChoice? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final mode = BookSeriesMode.fromWire(json['mode']);
    if (mode == null) return null;
    final projectId = json['projectId'];
    final title = json['title'];
    if (mode.linksBook && (projectId is! String || title is! String)) {
      return null;
    }
    return MobileCreationSeriesChoice(
      mode: mode,
      projectId: projectId is String ? projectId : null,
      title: title is String ? title : null,
    );
  }
}

/// The session's series state: the books on offer and the reader's answer.
class MobileCreationSeries {
  const MobileCreationSeries({this.books = const [], this.choice});

  final List<MobileCreationSeriesBook> books;
  final MobileCreationSeriesChoice? choice;

  /// Whether the chat should ask: there is a book to link and no answer yet.
  bool get isOpen => choice == null && books.isNotEmpty;

  static MobileCreationSeries? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final books = json['books'];
    return MobileCreationSeries(
      books: books is List
          ? books
                .map(MobileCreationSeriesBook.fromJson)
                .whereType<MobileCreationSeriesBook>()
                .toList(growable: false)
          : const [],
      choice: MobileCreationSeriesChoice.fromJson(json['choice']),
    );
  }
}

/// "Write the next book": the finished book a new chat continues, and its
/// format, fetched from `GET /api/mobile/projects/:id/next-book`.
class BookSeriesStart {
  const BookSeriesStart({
    required this.projectId,
    required this.title,
    required this.presets,
  });

  final String projectId;
  final String title;

  /// The format as the server sent it; see [chatPresets] for what the chat applies.
  final MobileCreationPresets presets;

  factory BookSeriesStart.fromJson(Map<String, dynamic> json) {
    return BookSeriesStart(
      projectId: json['projectId'] as String,
      title: (json['title'] as String? ?? '').trim(),
      presets: MobileCreationPresets.fromJson(
        json['presets'] as Map<String, dynamic>,
      ),
    );
  }

  /// [presets] with a concrete book-type choice, the remix's rule.
  MobileCreationPresets get chatPresets =>
      presets.copyWith(bookTypeChoice: concreteBookTypeChoice(presets));
}

/// The server's answer to `PUT …/series`: the conversation as it stands, and,
/// when the answer linked a book, that book's format — its own field, because
/// the chat applies it only to the settings the reader has not chosen
/// (`adoptSeriesFormat`), which the turn's presets would overwrite.
class MobileCreationSeriesAnswer {
  const MobileCreationSeriesAnswer({required this.response, this.format});

  final MobileCreationConversationResponse response;
  final MobileCreationPresets? format;

  factory MobileCreationSeriesAnswer.fromJson(Map<String, dynamic> json) {
    final format = json['seriesPresets'];
    return MobileCreationSeriesAnswer(
      response: MobileCreationConversationResponse.fromJson(json),
      format: format is Map<String, dynamic>
          ? MobileCreationPresets.fromJson(format)
          : null,
    );
  }

  /// [format] with a concrete book-type choice, the remix's rule.
  MobileCreationPresets? get chatFormat {
    final format = this.format;
    return format?.copyWith(bookTypeChoice: concreteBookTypeChoice(format));
  }
}

/// A link chosen before the chat has a session — a "Write the next book"
/// start, or a change of mind about it — sent with the request that starts it.
class PendingBookSeries {
  const PendingBookSeries({
    required this.projectId,
    required this.title,
    required this.mode,
  });

  final String projectId;
  final String title;
  final BookSeriesMode mode;

  Map<String, dynamic> toJson() => {'mode': mode.wire, 'projectId': projectId};
}
