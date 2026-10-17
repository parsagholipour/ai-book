import '../../voice/domain/voice_models.dart';

/// What `GET /api/mobile/projects/:id/making-of` says about how a finished
/// book was made: its cast, where each chapter starts, and what it read.
///
/// The cast entries are the voice cast's own, so a row here and a row in the
/// "Talk to characters" sheet are the same character. A key an older server
/// does not send reads as empty, so the section simply shows less.
class MobileMakingOf {
  const MobileMakingOf({
    this.cast = const [],
    this.chapters = const [],
    this.pdfDigest,
    this.sources = const [],
    this.sourceCount = 0,
  });

  factory MobileMakingOf.fromJson(Map<String, dynamic> json) {
    final sources = (json['sources'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(MakingOfSource.fromJson)
        .whereType<MakingOfSource>()
        .toList(growable: false);
    return MobileMakingOf(
      cast: (json['cast'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(VoiceCharacter.fromJson)
          .toList(growable: false),
      chapters: (json['chapters'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(MakingOfChapter.fromJson)
          .toList(growable: false),
      pdfDigest: json['pdfDigest'] as String?,
      sources: sources,
      sourceCount: (json['sourceCount'] as int?) ?? sources.length,
    );
  }

  static const empty = MobileMakingOf();

  final List<VoiceCharacter> cast;

  /// The chapters the book prints, in the order it prints them.
  final List<MakingOfChapter> chapters;

  /// The PDF every [MakingOfChapter.pdfPage] was measured in.
  final String? pdfDigest;

  /// The sources listed, which the server stops at a limit; [sourceCount] is
  /// every one the book read.
  final List<MakingOfSource> sources;
  final int sourceCount;

  /// The chapters the reader can be opened at. A book of one chapter has no
  /// shape worth drawing, so it reads as none.
  List<MakingOfChapter> get readableChapters {
    final readable = chapters
        .where((chapter) => chapter.firstPageIndex != null)
        .toList(growable: false);
    return readable.length < 2 ? const [] : readable;
  }

  bool get isEmpty =>
      cast.isEmpty && readableChapters.isEmpty && sources.isEmpty;
}

class MakingOfChapter {
  const MakingOfChapter({
    required this.index,
    required this.title,
    this.summary = '',
    this.firstPageIndex,
    this.pdfPage,
  });

  factory MakingOfChapter.fromJson(Map<String, dynamic> json) {
    return MakingOfChapter(
      index: json['index'] as int? ?? 0,
      title: (json['title'] as String? ?? '').trim(),
      summary: (json['summary'] as String? ?? '').trim(),
      firstPageIndex: json['firstPageIndex'] as int?,
      pdfPage: json['pdfPage'] as int?,
    );
  }

  final int index;
  final String title;
  final String summary;

  /// The book page the chapter opens on — the reader's `?page=`.
  final int? firstPageIndex;

  /// The sheet of the published PDF the chapter starts on, in the file
  /// [MobileMakingOf.pdfDigest] names.
  final int? pdfPage;
}

/// Where the reader opens for [chapter]: its sheet when the server measured
/// one, its book page either way, so a reader holding a different file still
/// finds the page by its text.
String readerLocationForChapter(
  String projectId,
  MakingOfChapter chapter,
  String? pdfDigest,
) {
  final sheet = chapter.pdfPage;
  return Uri(
    path: '/projects/$projectId/read',
    queryParameters: {
      'page': '${chapter.firstPageIndex}',
      if (sheet != null && pdfDigest != null) ...{
        'sheet': '$sheet',
        'digest': pdfDigest,
      },
    },
  ).toString();
}

class MakingOfSource {
  const MakingOfSource({required this.title, required this.uri, this.host});

  /// Null for an entry with no web address to open.
  static MakingOfSource? fromJson(Map<String, dynamic> json) {
    final uri = Uri.tryParse(json['url'] as String? ?? '');
    if (uri == null || (uri.scheme != 'https' && uri.scheme != 'http')) {
      return null;
    }
    final host = (json['host'] as String?)?.trim();
    final title = (json['title'] as String? ?? '').trim();
    return MakingOfSource(
      title: title.isEmpty ? (host ?? uri.host) : title,
      uri: uri,
      host: host == null || host.isEmpty ? null : host,
    );
  }

  final String title;
  final Uri uri;
  final String? host;

  /// The site under the title, unless the title already is the site.
  String? get subtitle =>
      host == null || host!.toLowerCase() == title.toLowerCase() ? null : host;
}
