import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_image_models.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

/// One library character, with only the fields these suites care about spelled
/// out at each call site.
LibraryCharacter testCharacter({
  String id = 'char-1',
  String name = 'Mina Park',
  String description = 'Brave, curious, always muddy.',
  String? suggestedDescription,
  bool hasPhoto = true,
  CharacterPhotoKind? photoKind,
  CharacterPortraitSource? portraitSource,
  CharacterPortraitStatus portraitStatus = CharacterPortraitStatus.none,
  String? portraitError,
  bool usedInBooks = false,
  List<CharacterMention> mentions = const [],
}) {
  return LibraryCharacter(
    id: id,
    name: name,
    description: description,
    mentions: mentions,
    suggestedDescription: suggestedDescription,
    hasPhoto: hasPhoto,
    photoKind: photoKind,
    portraitSource: portraitSource,
    portraitStatus: portraitStatus,
    portraitError: portraitError,
    usedInBooks: usedInBooks,
    createdAt: DateTime.utc(2026, 8, 1),
    updatedAt: DateTime.utc(2026, 8, 1),
  );
}

/// One retained picture.
CharacterImage testImage({
  String id = 'img-1',
  CharacterImageSource source = CharacterImageSource.generated,
  CharacterPhotoKind? photoKind,
  bool isMain = false,
  bool isCurrentPhoto = false,
  bool isCurrentReference = false,
  bool canBeMain = false,
  bool canBeShownAsPhoto = false,
  DateTime? createdAt,
}) {
  return CharacterImage(
    id: id,
    url: '/api/mobile/characters/char-1/images/$id',
    source: source,
    photoKind: photoKind,
    isMain: isMain,
    isCurrentPhoto: isCurrentPhoto,
    isCurrentReference: isCurrentReference,
    canBeMain: canBeMain,
    canBeShownAsPhoto: canBeShownAsPhoto,
    createdAt: createdAt ?? DateTime.utc(2026, 8, 2),
  );
}

/// A hand-written double for the whole repository surface.
///
/// Every mutation is recorded rather than performed, so a suite can assert on
/// what the UI asked the server to do — which is the only thing the widgets
/// actually own.
class FakeCharactersRepository implements CharactersRepository {
  FakeCharactersRepository(
    this._character, {
    List<CharacterImage>? images,
    List<LibraryCharacter>? libraryCharacters,
  }) : _images = images ?? const [],
       _libraryCharacters = libraryCharacters ?? [_character];

  LibraryCharacter _character;
  List<CharacterImage> _images;
  final List<LibraryCharacter> _libraryCharacters;

  final List<Map<String, Object?>> updates = [];
  final List<String> deletedPhotos = [];
  final List<String> promoted = [];
  final List<String> deletedImages = [];
  final List<String?> portraitRequests = [];
  final List<int> uploadedByteLengths = [];

  @override
  Future<CharacterLibrary> list() async => CharacterLibrary(
    characters: [
      for (final character in _libraryCharacters)
        if (character.id == _character.id) _character else character,
    ],
    portraitCredits: 45,
  );

  @override
  Future<LibraryCharacter> update({
    required String id,
    String? name,
    String? description,
    List<CharacterField>? fields,
    List<String>? mentionedCharacterIds,
    bool? dismissSuggestion,
  }) async {
    updates.add({
      'id': id,
      'name': ?name,
      'description': ?description,
      'fields': ?fields?.length,
      'mentionedCharacterIds': ?mentionedCharacterIds,
      'dismissSuggestion': ?dismissSuggestion,
    });
    _character = _character.copyWith(
      name: name,
      description: description,
      fields: fields,
      mentions: mentionedCharacterIds == null
          ? null
          : [
              for (final id in mentionedCharacterIds)
                CharacterMention(id: id, name: id),
            ],
      suggestedDescription: dismissSuggestion == true || description != null
          ? null
          : _character.suggestedDescription,
    );
    return _character;
  }

  @override
  Future<LibraryCharacter> create({
    required String name,
    String description = '',
    List<CharacterField> fields = const [],
    List<String> mentionedCharacterIds = const [],
  }) async => _character;

  @override
  Future<void> delete(String id) async {}

  @override
  Future<LibraryCharacter> uploadPhoto({
    required String id,
    required String filename,
    required List<int> bytes,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
  }) async {
    uploadedByteLengths.add(bytes.length);
    onProgress?.call(bytes.length, bytes.length);
    return _character;
  }

  @override
  Future<LibraryCharacter> deletePhoto(String id) async {
    deletedPhotos.add(id);
    _character = _character.copyWith(hasPhoto: false, photoKind: null);
    return _character;
  }

  @override
  Future<List<CharacterImage>> images(String id) async => _images;

  @override
  Future<CharacterImages> promoteImage({
    required String id,
    required String imageId,
  }) async {
    promoted.add(imageId);
    return (character: _character, images: _images);
  }

  @override
  Future<CharacterImages> deleteImage({
    required String id,
    required String imageId,
  }) async {
    deletedImages.add(imageId);
    _images = [
      for (final image in _images)
        if (image.id != imageId) image,
    ];
    return (character: _character, images: _images);
  }

  @override
  Future<CharacterPortraitStart> generatePortrait({
    required String id,
    String? requestId,
  }) async {
    portraitRequests.add(requestId);
    return (character: _character, creditsCharged: 45);
  }

  @override
  Future<Map<String, String>> assetHeaders() async => const {};
}
