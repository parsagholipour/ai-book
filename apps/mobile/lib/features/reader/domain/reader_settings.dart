/// How the page itself is tinted while reading.
///
/// A compiled PDF has fixed type, so the usual reader knobs — font, size,
/// margins — are not available. What is left is the light coming off the page,
/// which is also the thing that actually keeps people reading at night.
enum ReaderPageTint {
  none,
  sepia,
  gray,
  night;

  String get label => switch (this) {
    ReaderPageTint.none => 'Paper',
    ReaderPageTint.sepia => 'Sepia',
    ReaderPageTint.gray => 'Muted',
    ReaderPageTint.night => 'Night',
  };

  String get description => switch (this) {
    ReaderPageTint.none => 'The book as it was printed',
    ReaderPageTint.sepia => 'Warm, easier under lamplight',
    ReaderPageTint.gray => 'Takes the glare off white paper',
    ReaderPageTint.night => 'Inverted, for reading in the dark',
  };
}

/// Reader preferences, shared across every book.
///
/// Deliberately not per-book: someone who reads at night reads every book at
/// night, and having to set the tint again on each title would be a chore
/// rather than a feature.
class ReaderSettings {
  const ReaderSettings({
    this.tint = ReaderPageTint.none,
    this.dimLevel = 0,
    this.keepAwake = false,
    this.markupColorIndex = 0,
    this.inkColorIndex = 4,
    this.inkWidth = defaultInkWidth,
  });

  final ReaderPageTint tint;

  /// How much the whole page is dimmed, 0 to 1.
  ///
  /// A scrim rather than a system-brightness override: it needs no platform
  /// plugin, behaves the same everywhere, and night reading only ever wants to
  /// go darker than the phone's own minimum, never brighter.
  final double dimLevel;

  final bool keepAwake;

  /// Remembered palette choices, so the tool comes back the way it was left.
  final int markupColorIndex;
  final int inkColorIndex;

  /// Pen thickness as a fraction of the page width.
  final double inkWidth;

  static const defaultInkWidth = 0.004;
  static const minInkWidth = 0.0015;
  static const maxInkWidth = 0.012;
  static const maxDimLevel = 0.72;

  ReaderSettings copyWith({
    ReaderPageTint? tint,
    double? dimLevel,
    bool? keepAwake,
    int? markupColorIndex,
    int? inkColorIndex,
    double? inkWidth,
  }) {
    return ReaderSettings(
      tint: tint ?? this.tint,
      dimLevel: dimLevel ?? this.dimLevel,
      keepAwake: keepAwake ?? this.keepAwake,
      markupColorIndex: markupColorIndex ?? this.markupColorIndex,
      inkColorIndex: inkColorIndex ?? this.inkColorIndex,
      inkWidth: inkWidth ?? this.inkWidth,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'tint': tint.name,
      'dimLevel': dimLevel,
      'keepAwake': keepAwake,
      'markupColorIndex': markupColorIndex,
      'inkColorIndex': inkColorIndex,
      'inkWidth': inkWidth,
    };
  }

  factory ReaderSettings.fromJson(Map<String, dynamic> json) {
    final tint = ReaderPageTint.values.firstWhere(
      (value) => value.name == json['tint'],
      orElse: () => ReaderPageTint.none,
    );
    return ReaderSettings(
      tint: tint,
      dimLevel: ((json['dimLevel'] as num?)?.toDouble() ?? 0).clamp(
        0,
        maxDimLevel,
      ),
      keepAwake: json['keepAwake'] == true,
      markupColorIndex: json['markupColorIndex'] as int? ?? 0,
      inkColorIndex: json['inkColorIndex'] as int? ?? 4,
      inkWidth: ((json['inkWidth'] as num?)?.toDouble() ?? defaultInkWidth)
          .clamp(minInkWidth, maxInkWidth),
    );
  }
}
