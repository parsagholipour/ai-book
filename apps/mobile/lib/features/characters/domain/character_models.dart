// `characters` (grapheme clusters) reaches this file through Flutter's
// widgets export; initials must cut on user-perceived letters, never on code
// units, or an emoji or non-Latin name splits mid-character.
import 'package:flutter/widgets.dart' show StringCharacters;

/// Where a library character's AI portrait stands, mirroring the API's wire
/// values. Anything unrecognized reads as [none] so an older client survives a
/// newer server.
enum CharacterPortraitStatus {
  none,
  queued,
  generating,
  ready,
  failed;

  static CharacterPortraitStatus fromWire(String? value) {
    return switch (value) {
      'queued' => queued,
      'generating' => generating,
      'ready' => ready,
      'failed' => failed,
      _ => none,
    };
  }

  String get wire => name;

  /// A portrait the worker still owns. Deleting the character and asking for
  /// another portrait are refused while this is true, and the library polls
  /// until it settles.
  bool get isBusy => this == queued || this == generating;
}

/// What the uploaded image turned out to be, read once by the server when the
/// photo was uploaded. Null until an image has been read.
enum CharacterPhotoKind {
  photograph,
  illustration,
  unknown;

  static CharacterPhotoKind? fromWire(String? value) {
    return switch (value) {
      'photograph' => photograph,
      'illustration' => illustration,
      'unknown' => unknown,
      _ => null,
    };
  }

  String get wire => name;
}

/// Where the character's reference image came from: a drawing the reader paid
/// for, or their own artwork adopted as it stands.
enum CharacterPortraitSource {
  generated,
  adoptedUpload;

  static CharacterPortraitSource? fromWire(String? value) {
    return switch (value) {
      'generated' => generated,
      'adopted_upload' => adoptedUpload,
      _ => null,
    };
  }

  String get wire => this == adoptedUpload ? 'adopted_upload' : 'generated';
}

/// One "detail" line of a character: `Age: 9`, `Likes: thunderstorms`.
class CharacterField {
  const CharacterField({required this.key, required this.value});

  final String key;
  final String value;

  factory CharacterField.fromJson(Map<String, dynamic> json) {
    return CharacterField(
      key: json['key'] as String? ?? '',
      value: json['value'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {'key': key, 'value': value};

  /// Reads a fields array defensively: entries missing either half are dropped
  /// rather than rendered as blanks, matching the API serializer's own rule.
  static List<CharacterField> listFromJson(Object? json) {
    if (json is! List) return const [];
    return [
      for (final entry in json)
        if (entry is Map && entry['key'] is String && entry['value'] is String)
          CharacterField(
            key: entry['key'] as String,
            value: entry['value'] as String,
          ),
    ];
  }
}

/// One durable @mention in a character description.
class CharacterMention {
  const CharacterMention({required this.id, required this.name});

  final String id;
  final String name;

  factory CharacterMention.fromJson(Map<String, dynamic> json) =>
      CharacterMention(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name};

  static List<CharacterMention> listFromJson(Object? json) {
    if (json is! List) return const [];
    return [
      for (final entry in json)
        if (entry is Map && entry['id'] is String && entry['name'] is String)
          CharacterMention(
            id: entry['id'] as String,
            name: entry['name'] as String,
          ),
    ];
  }
}

/// An account-wide library character. Books snapshot these at build time and
/// hold no reference back, so nothing here belongs to any one project.
class LibraryCharacter {
  const LibraryCharacter({
    required this.id,
    required this.name,
    this.description = '',
    this.mentions = const [],
    this.fields = const [],
    this.portraitStatus = CharacterPortraitStatus.none,
    this.portraitError,
    this.portraitSource,
    this.hasPhoto = false,
    this.photoKind,
    this.suggestedDescription,
    this.usedInBooks = false,
    this.photoUrl,
    this.portraitUrl,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String name;
  final String description;
  final List<CharacterMention> mentions;
  final List<CharacterField> fields;
  final CharacterPortraitStatus portraitStatus;

  /// Why the last portrait attempt failed; only set while [portraitStatus] is
  /// [CharacterPortraitStatus.failed].
  final String? portraitError;

  final CharacterPortraitSource? portraitSource;

  final bool hasPhoto;

  /// Null until the server has read the photo — an older upload, or a
  /// deployment with no vision model configured.
  final CharacterPhotoKind? photoKind;

  /// A description the server read off the photo. It is only ever an offer:
  /// nothing applies it but the reader tapping "Use this".
  final String? suggestedDescription;

  /// Whether this character's look actually reaches an illustrated book. A
  /// stored photo alone does not — it has to become a reference image first.
  final bool usedInBooks;

  /// Authenticated API paths — resolve against the base URL and send bearer
  /// headers, like every other asset URL the API hands out.
  final String? photoUrl;
  final String? portraitUrl;

  final DateTime createdAt;
  final DateTime updatedAt;

  /// An image is stored but no book can draw from it yet. This is the one
  /// state where the library quietly does less than the reader expects — the
  /// avatar shows the uploaded face on every screen — so every surface that
  /// can say so, does.
  ///
  /// Deliberately not keyed on [photoKind]: an illustration is normally
  /// adopted on upload, but one that was not (a portrait job held the row, or
  /// the reading was unsure) owes the reader exactly the same step.
  bool get needsCartoonReference =>
      hasPhoto && !usedInBooks && !portraitStatus.isBusy;

  factory LibraryCharacter.fromJson(Map<String, dynamic> json) {
    return LibraryCharacter(
      id: json['id'] as String,
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      mentions: CharacterMention.listFromJson(json['mentions']),
      fields: CharacterField.listFromJson(json['fields']),
      portraitStatus: CharacterPortraitStatus.fromWire(
        json['portraitStatus'] as String?,
      ),
      portraitError: json['portraitError'] as String?,
      portraitSource: CharacterPortraitSource.fromWire(
        json['portraitSource'] as String?,
      ),
      hasPhoto: json['hasPhoto'] as bool? ?? false,
      photoKind: CharacterPhotoKind.fromWire(json['photoKind'] as String?),
      suggestedDescription: json['suggestedDescription'] as String?,
      usedInBooks: json['usedInBooks'] as bool? ?? false,
      photoUrl: json['photoUrl'] as String?,
      portraitUrl: json['portraitUrl'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'mentions': [for (final mention in mentions) mention.toJson()],
      'fields': [for (final field in fields) field.toJson()],
      'portraitStatus': portraitStatus.wire,
      'portraitError': portraitError,
      'portraitSource': portraitSource?.wire,
      'hasPhoto': hasPhoto,
      'photoKind': photoKind?.wire,
      'suggestedDescription': suggestedDescription,
      'usedInBooks': usedInBooks,
      'photoUrl': photoUrl,
      'portraitUrl': portraitUrl,
      'createdAt': createdAt.toUtc().toIso8601String(),
      'updatedAt': updatedAt.toUtc().toIso8601String(),
    };
  }

  /// The best image to draw: the finished portrait, else the reference photo.
  String? get displayImageUrl => portraitUrl ?? photoUrl;

  /// One or two letters for the avatar fallback: first letter of the first
  /// word, plus the first letter of the last word when there is one.
  String get initials {
    final parts = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty)
        .toList();
    if (parts.isEmpty) return '?';
    final first = parts.first.characters.first;
    if (parts.length == 1) return first.toUpperCase();
    return (first + parts.last.characters.first).toUpperCase();
  }

  static const _sentinel = Object();

  LibraryCharacter copyWith({
    String? name,
    String? description,
    List<CharacterMention>? mentions,
    List<CharacterField>? fields,
    CharacterPortraitStatus? portraitStatus,
    Object? portraitError = _sentinel,
    Object? portraitSource = _sentinel,
    bool? hasPhoto,
    Object? photoKind = _sentinel,
    Object? suggestedDescription = _sentinel,
    bool? usedInBooks,
    Object? photoUrl = _sentinel,
    Object? portraitUrl = _sentinel,
    DateTime? updatedAt,
  }) {
    return LibraryCharacter(
      id: id,
      name: name ?? this.name,
      description: description ?? this.description,
      mentions: mentions ?? this.mentions,
      fields: fields ?? this.fields,
      portraitStatus: portraitStatus ?? this.portraitStatus,
      portraitError: identical(portraitError, _sentinel)
          ? this.portraitError
          : portraitError as String?,
      portraitSource: identical(portraitSource, _sentinel)
          ? this.portraitSource
          : portraitSource as CharacterPortraitSource?,
      hasPhoto: hasPhoto ?? this.hasPhoto,
      photoKind: identical(photoKind, _sentinel)
          ? this.photoKind
          : photoKind as CharacterPhotoKind?,
      suggestedDescription: identical(suggestedDescription, _sentinel)
          ? this.suggestedDescription
          : suggestedDescription as String?,
      usedInBooks: usedInBooks ?? this.usedInBooks,
      photoUrl: identical(photoUrl, _sentinel)
          ? this.photoUrl
          : photoUrl as String?,
      portraitUrl: identical(portraitUrl, _sentinel)
          ? this.portraitUrl
          : portraitUrl as String?,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}

/// The `GET /api/mobile/characters` payload: the characters plus what one
/// portrait costs right now. The price is operator-editable on the server, so
/// it travels with the list rather than being compiled into the app.
class CharacterLibrary {
  const CharacterLibrary({
    this.characters = const [],
    this.portraitCredits = 0,
  });

  final List<LibraryCharacter> characters;
  final int portraitCredits;

  factory CharacterLibrary.fromJson(Map<String, dynamic> json) {
    final list = json['characters'];
    return CharacterLibrary(
      characters: [
        for (final entry in list is List ? list : const <dynamic>[])
          if (entry is Map<String, dynamic>) LibraryCharacter.fromJson(entry),
      ],
      portraitCredits: json['portraitCredits'] as int? ?? 0,
    );
  }

  /// Whether any portrait is still being drawn — the signal the library screen
  /// polls on.
  bool get hasBusyPortrait =>
      characters.any((character) => character.portraitStatus.isBusy);
}
