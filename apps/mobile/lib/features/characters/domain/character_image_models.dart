import 'character_models.dart';

/// Where the bytes of one retained picture came from.
enum CharacterImageSource {
  upload,
  generated;

  static CharacterImageSource fromWire(String? value) {
    return value == 'generated' ? generated : upload;
  }

  String get wire => name;
}

/// One retained version of a character's picture — every photo they uploaded
/// and every illustration that was drawn for them.
///
/// [url] is immutable: one id is one set of bytes for good, which is what lets
/// the header, the strip and the viewer share Flutter's image cache. It carries
/// no `?v=` buster and must never be given one. ([CharacterAvatar] still busts
/// its own two alias URLs, whose bytes really do change under one name.)
class CharacterImage {
  const CharacterImage({
    required this.id,
    required this.url,
    required this.source,
    required this.createdAt,
    this.photoKind,
    this.isMain = false,
    this.isCurrentPhoto = false,
    this.isCurrentReference = false,
    this.canBeMain = false,
    this.canBeShownAsPhoto = false,
    this.width,
    this.height,
  });

  final String id;
  final String url;
  final CharacterImageSource source;

  /// What the server judged this upload to be, if it was ever read.
  final CharacterPhotoKind? photoKind;

  /// The picture every surface shows: the reference when the character has
  /// one, else the stored photo.
  final bool isMain;
  final bool isCurrentPhoto;
  final bool isCurrentReference;

  /// Whether making this the main picture would move what books draw from.
  /// Only this flag may be paired with copy that mentions books.
  final bool canBeMain;

  /// Whether this upload can become the character's photo without touching
  /// what books draw from. Never true once a reference exists.
  final bool canBeShownAsPhoto;

  final int? width;
  final int? height;
  final DateTime createdAt;

  /// The reader's own artwork: an upload the server judged to be a drawing.
  /// Worth telling apart from a photo, because it is the one upload a book can
  /// use as it stands.
  bool get isOwnArtwork =>
      source == CharacterImageSource.upload &&
      photoKind == CharacterPhotoKind.illustration;

  factory CharacterImage.fromJson(Map<String, dynamic> json) {
    return CharacterImage(
      id: json['id'] as String,
      url: json['url'] as String? ?? '',
      source: CharacterImageSource.fromWire(json['source'] as String?),
      photoKind: CharacterPhotoKind.fromWire(json['photoKind'] as String?),
      isMain: json['isMain'] as bool? ?? false,
      isCurrentPhoto: json['isCurrentPhoto'] as bool? ?? false,
      isCurrentReference: json['isCurrentReference'] as bool? ?? false,
      canBeMain: json['canBeMain'] as bool? ?? false,
      canBeShownAsPhoto: json['canBeShownAsPhoto'] as bool? ?? false,
      width: json['width'] as int?,
      height: json['height'] as int?,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'url': url,
      'source': source.wire,
      'photoKind': photoKind?.wire,
      'isMain': isMain,
      'isCurrentPhoto': isCurrentPhoto,
      'isCurrentReference': isCurrentReference,
      'canBeMain': canBeMain,
      'canBeShownAsPhoto': canBeShownAsPhoto,
      'width': width,
      'height': height,
      'createdAt': createdAt.toUtc().toIso8601String(),
    };
  }

  /// Reads an images array defensively: an entry with no id is dropped rather
  /// than rendered as a tile nothing can act on.
  static List<CharacterImage> listFromJson(Object? json) {
    if (json is! List) return const [];
    return [
      for (final entry in json)
        if (entry is Map<String, dynamic> && entry['id'] is String)
          CharacterImage.fromJson(entry),
    ];
  }
}
