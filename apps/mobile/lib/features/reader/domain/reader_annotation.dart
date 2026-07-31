import 'reader_annotation_geometry.dart';

/// How a passage is marked up.
enum ReaderMarkupStyle { highlight, underline, strikethrough }

/// The kinds of markup the reader can leave on a book, in the order they are
/// listed to the user.
enum ReaderAnnotationKind { highlight, underline, strikethrough, note, ink, text }

/// One piece of markup on a book.
///
/// Every annotation records the PDF page it sits on and the export [revision]
/// that page numbering belonged to. A recompile repaginates the book, so
/// anything anchored to text also stores the [quote] it was made against and
/// can be found again; anything geometric (ink, a placed text box) cannot, and
/// is kept but flagged as belonging to an earlier version.
///
/// The `id` / `updatedAt` / `deletedAt` triple is not needed by anything today
/// — markup lives in a file on the device. It is here because that file is the
/// documented seam for moving reading state server-side, and a tombstone that
/// was never recorded cannot be reconstructed later.
sealed class ReaderAnnotation {
  const ReaderAnnotation({
    required this.id,
    required this.page,
    required this.revision,
    required this.colorIndex,
    required this.createdAt,
    required this.updatedAt,
    this.deletedAt,
    this.orphaned = false,
  });

  final String id;

  /// The PDF page number, 1-based, as pdfrx counts them.
  final int page;

  /// The export revision [page] was recorded against.
  final int revision;

  /// An index into the reader's markup palette rather than a raw colour, so
  /// markup stays legible when the app theme changes.
  final int colorIndex;

  final DateTime createdAt;
  final DateTime updatedAt;

  /// Set instead of deleting the row outright, so a later sync can propagate
  /// the removal rather than resurrecting the annotation from another device.
  final DateTime? deletedAt;

  /// The passage this was attached to could not be found after a recompile.
  /// Kept and listed, but not painted anywhere — a highlight over the wrong
  /// words is worse than one the reader is told has come loose.
  final bool orphaned;

  bool get isDeleted => deletedAt != null;

  /// Whether this annotation should be drawn on [page] at [revision].
  bool get isPlaceable => !isDeleted && !orphaned;

  ReaderAnnotationKind get kind;

  /// The text this annotation was made against, when it has one. Drives
  /// re-anchoring and every action that hands a passage to the book chat.
  String? get quote => null;

  /// The book page (`Page.index`) the passage belongs to, when it was resolved.
  int? get bookPageIndex => null;

  /// What the reader typed, for the kinds that carry text.
  String? get body => null;

  /// The line shown for this annotation in the markup index.
  String get preview {
    final text = (body?.trim().isNotEmpty ?? false) ? body! : quote ?? '';
    final collapsed = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (collapsed.isEmpty) {
      return switch (kind) {
        ReaderAnnotationKind.ink => 'Drawing',
        ReaderAnnotationKind.text => 'Empty note',
        _ => 'Page $page',
      };
    }
    return collapsed.length <= 120
        ? collapsed
        : '${collapsed.substring(0, 120).trimRight()}…';
  }

  /// Whether this was made against a different build of the book.
  bool isStaleFor(int currentRevision) => revision != currentRevision;

  /// Re-places the annotation, or marks it as having come loose.
  ReaderAnnotation withAnchoring({
    int? page,
    int? revision,
    List<NormRect>? rects,
    bool? orphaned,
  });

  /// The same annotation in a different palette colour.
  ReaderAnnotation recolored(int colorIndex);

  /// Whether a tap at [point] on this annotation's page should open it.
  ///
  /// [slop] is a fingertip in page fractions. A line of type is around two
  /// percent of a page tall, so without it the only markup anyone could reliably
  /// tap would be their own drawings.
  bool hitTest(NormPoint point, {double slop = defaultTouchSlop});

  /// Roughly a fingertip on a phone-sized page.
  static const defaultTouchSlop = 0.012;

  /// The rectangles this annotation occupies, for working out whether new
  /// markup lands on top of it. Empty for anything that is not text-anchored.
  List<NormRect> get occupiedRects => const [];

  ReaderAnnotation deleted(DateTime at);

  Map<String, dynamic> toJson();

  Map<String, dynamic> _baseJson(String type) {
    return {
      'type': type,
      'id': id,
      'page': page,
      'revision': revision,
      'colorIndex': colorIndex,
      'createdAt': createdAt.toIso8601String(),
      'updatedAt': updatedAt.toIso8601String(),
      if (deletedAt != null) 'deletedAt': deletedAt!.toIso8601String(),
      if (orphaned) 'orphaned': true,
    };
  }

  /// Rebuilds an annotation, or returns null for anything unreadable.
  ///
  /// A single corrupt entry must not cost the reader the rest of their markup,
  /// so every failure is local: the caller filters the nulls out.
  static ReaderAnnotation? fromJson(Map<String, dynamic> json) {
    final base = _BaseFields.fromJson(json);
    if (base == null) {
      return null;
    }
    return switch (json['type']) {
      'markup' => TextMarkupAnnotation._fromJson(base, json),
      'note' => NoteAnnotation._fromJson(base, json),
      'ink' => InkAnnotation._fromJson(base, json),
      'text' => TextBoxAnnotation._fromJson(base, json),
      _ => null,
    };
  }
}

/// A highlight, underline or strikethrough over a run of text.
class TextMarkupAnnotation extends ReaderAnnotation {
  const TextMarkupAnnotation({
    required super.id,
    required super.page,
    required super.revision,
    required super.colorIndex,
    required super.createdAt,
    required super.updatedAt,
    required this.style,
    required this.rects,
    required this.quote,
    super.deletedAt,
    super.orphaned,
    this.bookPageIndex,
  });

  final ReaderMarkupStyle style;

  /// One rectangle per line of the marked run, in page fractions.
  final List<NormRect> rects;

  @override
  final String quote;

  @override
  final int? bookPageIndex;

  @override
  ReaderAnnotationKind get kind => switch (style) {
    ReaderMarkupStyle.highlight => ReaderAnnotationKind.highlight,
    ReaderMarkupStyle.underline => ReaderAnnotationKind.underline,
    ReaderMarkupStyle.strikethrough => ReaderAnnotationKind.strikethrough,
  };

  TextMarkupAnnotation copyWith({
    int? colorIndex,
    ReaderMarkupStyle? style,
    DateTime? updatedAt,
  }) {
    return TextMarkupAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? this.colorIndex,
      createdAt: createdAt,
      updatedAt: updatedAt ?? DateTime.now(),
      style: style ?? this.style,
      rects: rects,
      quote: quote,
      deletedAt: deletedAt,
      orphaned: orphaned,
      bookPageIndex: bookPageIndex,
    );
  }

  @override
  TextMarkupAnnotation withAnchoring({
    int? page,
    int? revision,
    List<NormRect>? rects,
    bool? orphaned,
  }) {
    return TextMarkupAnnotation(
      id: id,
      page: page ?? this.page,
      revision: revision ?? this.revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: updatedAt,
      style: style,
      rects: rects ?? this.rects,
      quote: quote,
      deletedAt: deletedAt,
      orphaned: orphaned ?? this.orphaned,
      bookPageIndex: bookPageIndex,
    );
  }

  @override
  TextMarkupAnnotation recolored(int colorIndex) =>
      copyWith(colorIndex: colorIndex);

  @override
  List<NormRect> get occupiedRects => rects;

  @override
  bool hitTest(NormPoint point, {double slop = ReaderAnnotation.defaultTouchSlop}) {
    return rects.any((rect) => rect.inflate(slop).contains(point));
  }

  @override
  TextMarkupAnnotation deleted(DateTime at) {
    return TextMarkupAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: at,
      style: style,
      rects: rects,
      quote: quote,
      deletedAt: at,
      orphaned: orphaned,
      bookPageIndex: bookPageIndex,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      ..._baseJson('markup'),
      'style': style.name,
      'quote': quote,
      if (bookPageIndex != null) 'bookPageIndex': bookPageIndex,
      'rects': [for (final rect in rects) rect.toJson()],
    };
  }

  static TextMarkupAnnotation? _fromJson(
    _BaseFields base,
    Map<String, dynamic> json,
  ) {
    final quote = json['quote'];
    if (quote is! String) {
      return null;
    }
    final rects = <NormRect>[];
    for (final raw in json['rects'] as List<dynamic>? ?? const []) {
      final rect = NormRect.fromJson(raw);
      if (rect != null) {
        rects.add(rect);
      }
    }
    final style = ReaderMarkupStyle.values.firstWhere(
      (value) => value.name == json['style'],
      orElse: () => ReaderMarkupStyle.highlight,
    );
    return TextMarkupAnnotation(
      id: base.id,
      page: base.page,
      revision: base.revision,
      colorIndex: base.colorIndex,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      style: style,
      rects: rects,
      quote: quote,
      deletedAt: base.deletedAt,
      orphaned: base.orphaned,
      bookPageIndex: json['bookPageIndex'] as int?,
    );
  }
}

/// A written note, pinned either to a passage or to a spot on the page.
class NoteAnnotation extends ReaderAnnotation {
  const NoteAnnotation({
    required super.id,
    required super.page,
    required super.revision,
    required super.colorIndex,
    required super.createdAt,
    required super.updatedAt,
    required this.anchor,
    required this.body,
    super.deletedAt,
    super.orphaned,
    this.quote,
    this.bookPageIndex,
    this.rects = const [],
  });

  /// Where the pin sits on the page.
  final NormPoint anchor;

  @override
  final String body;

  @override
  final String? quote;

  @override
  final int? bookPageIndex;

  /// The passage the note was taken on, when it came from a selection. Drawn
  /// faintly so a note attached to text shows what it is about.
  final List<NormRect> rects;

  @override
  ReaderAnnotationKind get kind => ReaderAnnotationKind.note;

  NoteAnnotation copyWith({String? body, int? colorIndex, NormPoint? anchor}) {
    return NoteAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? this.colorIndex,
      createdAt: createdAt,
      updatedAt: DateTime.now(),
      anchor: anchor ?? this.anchor,
      body: body ?? this.body,
      deletedAt: deletedAt,
      orphaned: orphaned,
      quote: quote,
      bookPageIndex: bookPageIndex,
      rects: rects,
    );
  }

  @override
  NoteAnnotation withAnchoring({
    int? page,
    int? revision,
    List<NormRect>? rects,
    bool? orphaned,
  }) {
    final moved = rects ?? this.rects;
    return NoteAnnotation(
      id: id,
      page: page ?? this.page,
      revision: revision ?? this.revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: updatedAt,
      // A note that followed its passage moves its pin with it rather than
      // staying at coordinates that now point elsewhere.
      anchor: rects != null && moved.isNotEmpty ? pinFor(moved) : anchor,
      body: body,
      deletedAt: deletedAt,
      orphaned: orphaned ?? this.orphaned,
      quote: quote,
      bookPageIndex: bookPageIndex,
      rects: moved,
    );
  }

  @override
  NoteAnnotation recolored(int colorIndex) => copyWith(colorIndex: colorIndex);

  @override
  List<NormRect> get occupiedRects => rects;

  /// How wide the pin is drawn, as a fraction of the page. Kept beside the
  /// hit test so the target and the thing drawn cannot drift apart.
  static const pinSize = 0.052;

  /// The gap between the pin and the words it belongs to.
  static const pinGap = 0.008;

  /// Where a pin sits for a passage: in the left margin, beside the first line.
  ///
  /// The left is the only side with room. A line of prose ends wherever the
  /// text happens to wrap, so a pin placed after it lands on top of the words
  /// as often as beside them, and on a line that runs to the right margin there
  /// is nowhere for it to go at all. The left edge of every line in a block of
  /// text is the same place, and the margin there is empty by construction.
  ///
  /// Shared by the creation path and by re-anchoring, so a note that follows
  /// its passage into a new edition lands where a fresh one would.
  static NormPoint pinFor(List<NormRect> rects) {
    if (rects.isEmpty) {
      return const NormPoint(0.02, 0.06);
    }
    return NormPoint(
      // Clamped rather than allowed to go negative: a book with almost no left
      // margin gets a pin tight against the edge instead of one off the page.
      (rects.first.left - pinGap - pinSize).clamp(0.0, 1.0 - pinSize),
      rects.first.top,
    );
  }

  @override
  bool hitTest(NormPoint point, {double slop = ReaderAnnotation.defaultTouchSlop}) {
    final pin = NormRect(anchor.x, anchor.y, pinSize, pinSize);
    if (pin.inflate(slop).contains(point)) {
      return true;
    }
    // The passage the note was taken on opens it too: the pin is small and the
    // underlined words are the part the reader is actually looking at.
    return rects.any((rect) => rect.inflate(slop).contains(point));
  }

  @override
  NoteAnnotation deleted(DateTime at) {
    return NoteAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: at,
      anchor: anchor,
      body: body,
      deletedAt: at,
      orphaned: orphaned,
      quote: quote,
      bookPageIndex: bookPageIndex,
      rects: rects,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      ..._baseJson('note'),
      'anchor': anchor.toJson(),
      'body': body,
      if (quote != null) 'quote': quote,
      if (bookPageIndex != null) 'bookPageIndex': bookPageIndex,
      if (rects.isNotEmpty) 'rects': [for (final rect in rects) rect.toJson()],
    };
  }

  static NoteAnnotation? _fromJson(
    _BaseFields base,
    Map<String, dynamic> json,
  ) {
    final anchor = NormPoint.fromJson(json['anchor']);
    if (anchor == null) {
      return null;
    }
    final rects = <NormRect>[];
    for (final raw in json['rects'] as List<dynamic>? ?? const []) {
      final rect = NormRect.fromJson(raw);
      if (rect != null) {
        rects.add(rect);
      }
    }
    return NoteAnnotation(
      id: base.id,
      page: base.page,
      revision: base.revision,
      colorIndex: base.colorIndex,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      anchor: anchor,
      body: json['body'] as String? ?? '',
      deletedAt: base.deletedAt,
      orphaned: base.orphaned,
      quote: json['quote'] as String?,
      bookPageIndex: json['bookPageIndex'] as int?,
      rects: rects,
    );
  }
}

/// Freehand drawing on a page.
class InkAnnotation extends ReaderAnnotation {
  const InkAnnotation({
    required super.id,
    required super.page,
    required super.revision,
    required super.colorIndex,
    required super.createdAt,
    required super.updatedAt,
    required this.strokes,
    super.deletedAt,
    super.orphaned,
  });

  final List<InkStroke> strokes;

  @override
  ReaderAnnotationKind get kind => ReaderAnnotationKind.ink;

  @override
  InkAnnotation withAnchoring({
    int? page,
    int? revision,
    List<NormRect>? rects,
    bool? orphaned,
  }) {
    // Ink has no text to find again. It keeps its position and only its
    // revision moves, which is what marks it as belonging to an earlier build.
    return InkAnnotation(
      id: id,
      page: page ?? this.page,
      revision: revision ?? this.revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: updatedAt,
      strokes: strokes,
      deletedAt: deletedAt,
      orphaned: orphaned ?? this.orphaned,
    );
  }

  @override
  bool hitTest(NormPoint point, {double slop = ReaderAnnotation.defaultTouchSlop}) {
    return strokes.any((stroke) => stroke.hitTest(point, slop));
  }

  @override
  InkAnnotation recolored(int colorIndex) {
    // The strokes carry their own colour so a drawing can be built up in
    // several, but recolouring the annotation means recolouring all of it.
    return InkAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: DateTime.now(),
      strokes: [
        for (final stroke in strokes)
          InkStroke(
            points: stroke.points,
            colorIndex: colorIndex,
            width: stroke.width,
          ),
      ],
      deletedAt: deletedAt,
      orphaned: orphaned,
    );
  }

  @override
  InkAnnotation deleted(DateTime at) {
    return InkAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: at,
      strokes: strokes,
      deletedAt: at,
      orphaned: orphaned,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      ..._baseJson('ink'),
      'strokes': [for (final stroke in strokes) stroke.toJson()],
    };
  }

  static InkAnnotation? _fromJson(_BaseFields base, Map<String, dynamic> json) {
    final strokes = <InkStroke>[];
    for (final raw in json['strokes'] as List<dynamic>? ?? const []) {
      if (raw is! Map<String, dynamic>) {
        continue;
      }
      final stroke = InkStroke.fromJson(raw);
      if (stroke != null) {
        strokes.add(stroke);
      }
    }
    if (strokes.isEmpty) {
      return null;
    }
    return InkAnnotation(
      id: base.id,
      page: base.page,
      revision: base.revision,
      colorIndex: base.colorIndex,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      strokes: strokes,
      deletedAt: base.deletedAt,
      orphaned: base.orphaned,
    );
  }
}

/// Typed text placed directly on the page.
class TextBoxAnnotation extends ReaderAnnotation {
  const TextBoxAnnotation({
    required super.id,
    required super.page,
    required super.revision,
    required super.colorIndex,
    required super.createdAt,
    required super.updatedAt,
    required this.anchor,
    required this.body,
    this.widthFraction = 0.4,
    this.fontScale = 1,
    super.deletedAt,
    super.orphaned,
  });

  /// The top-left corner of the box.
  final NormPoint anchor;

  @override
  final String body;

  /// How much of the page width the box takes, so wrapping is the same
  /// wherever it is opened.
  final double widthFraction;

  final double fontScale;

  @override
  ReaderAnnotationKind get kind => ReaderAnnotationKind.text;

  TextBoxAnnotation copyWith({
    String? body,
    int? colorIndex,
    NormPoint? anchor,
    double? widthFraction,
    double? fontScale,
  }) {
    return TextBoxAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? this.colorIndex,
      createdAt: createdAt,
      updatedAt: DateTime.now(),
      anchor: anchor ?? this.anchor,
      body: body ?? this.body,
      widthFraction: widthFraction ?? this.widthFraction,
      fontScale: fontScale ?? this.fontScale,
      deletedAt: deletedAt,
      orphaned: orphaned,
    );
  }

  @override
  TextBoxAnnotation withAnchoring({
    int? page,
    int? revision,
    List<NormRect>? rects,
    bool? orphaned,
  }) {
    return TextBoxAnnotation(
      id: id,
      page: page ?? this.page,
      revision: revision ?? this.revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: updatedAt,
      anchor: anchor,
      body: body,
      widthFraction: widthFraction,
      fontScale: fontScale,
      deletedAt: deletedAt,
      orphaned: orphaned ?? this.orphaned,
    );
  }

  @override
  TextBoxAnnotation recolored(int colorIndex) =>
      copyWith(colorIndex: colorIndex);

  /// The box's height is decided by the text once it is laid out, which the
  /// model cannot know. Three lines is close enough to tap.
  static const assumedHeight = 0.08;

  @override
  bool hitTest(NormPoint point, {double slop = ReaderAnnotation.defaultTouchSlop}) {
    final box = NormRect(anchor.x, anchor.y, widthFraction, assumedHeight);
    return box.inflate(slop).contains(point);
  }

  @override
  TextBoxAnnotation deleted(DateTime at) {
    return TextBoxAnnotation(
      id: id,
      page: page,
      revision: revision,
      colorIndex: colorIndex,
      createdAt: createdAt,
      updatedAt: at,
      anchor: anchor,
      body: body,
      widthFraction: widthFraction,
      fontScale: fontScale,
      deletedAt: at,
      orphaned: orphaned,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      ..._baseJson('text'),
      'anchor': anchor.toJson(),
      'body': body,
      'widthFraction': widthFraction,
      'fontScale': fontScale,
    };
  }

  static TextBoxAnnotation? _fromJson(
    _BaseFields base,
    Map<String, dynamic> json,
  ) {
    final anchor = NormPoint.fromJson(json['anchor']);
    if (anchor == null) {
      return null;
    }
    return TextBoxAnnotation(
      id: base.id,
      page: base.page,
      revision: base.revision,
      colorIndex: base.colorIndex,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      anchor: anchor,
      body: json['body'] as String? ?? '',
      widthFraction: (json['widthFraction'] as num?)?.toDouble() ?? 0.4,
      fontScale: (json['fontScale'] as num?)?.toDouble() ?? 1,
      deletedAt: base.deletedAt,
      orphaned: base.orphaned,
    );
  }
}

/// The fields every annotation shares, parsed once before the type is known.
class _BaseFields {
  const _BaseFields({
    required this.id,
    required this.page,
    required this.revision,
    required this.colorIndex,
    required this.createdAt,
    required this.updatedAt,
    required this.deletedAt,
    required this.orphaned,
  });

  final String id;
  final int page;
  final int revision;
  final int colorIndex;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? deletedAt;
  final bool orphaned;

  static _BaseFields? fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final page = json['page'];
    if (id is! String || id.isEmpty || page is! int || page < 1) {
      return null;
    }
    final createdAt =
        DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.fromMillisecondsSinceEpoch(0);
    return _BaseFields(
      id: id,
      page: page,
      revision: json['revision'] as int? ?? 0,
      colorIndex: json['colorIndex'] as int? ?? 0,
      createdAt: createdAt,
      updatedAt:
          DateTime.tryParse(json['updatedAt'] as String? ?? '') ?? createdAt,
      deletedAt: DateTime.tryParse(json['deletedAt'] as String? ?? ''),
      orphaned: json['orphaned'] == true,
    );
  }
}
