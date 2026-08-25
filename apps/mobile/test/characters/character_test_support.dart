import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_image_models.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/characters/presentation/character_editor_sheet.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// Opens the editor sheet over [saved], with [libraryCharacters] standing in
/// for everything else the reader has saved.
///
/// Answers the repository double, which is where a suite reads what the sheet
/// asked the server to do.
Future<FakeCharactersRepository> pumpCharacterEditorSheet(
  WidgetTester tester,
  LibraryCharacter saved, {
  List<LibraryCharacter>? libraryCharacters,
}) async {
  final repository = FakeCharactersRepository(
    saved,
    libraryCharacters: libraryCharacters,
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [charactersRepositoryProvider.overrideWithValue(repository)],
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showCharacterEditorSheet(context, character: saved),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return repository;
}

/// The 3-second library poll landing: whatever
/// [FakeCharactersRepository.replaceLibraryCharacter] was told about reaches
/// the widgets watching it.
Future<void> pumpLibraryPoll(WidgetTester tester) async {
  ProviderScope.containerOf(
    tester.element(find.byType(MaterialApp)),
    listen: false,
  ).invalidate(charactersProvider);
  await tester.pumpAndSettle();
}

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
  List<LibraryMention> mentions = const [],
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

  /// Stands in for the 3-second poll picking up what another device did: the
  /// next `list()` answers with [character] in place of the row it replaces.
  void replaceLibraryCharacter(LibraryCharacter character) {
    final index = _libraryCharacters.indexWhere(
      (row) => row.id == character.id,
    );
    if (index >= 0) _libraryCharacters[index] = character;
    if (character.id == _character.id) _character = character;
  }

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
    // The update route's own rule, so a suite can watch the sheet meet it:
    // every id in `mentionedCharacterIds` is looked up in `libraryCharacter`,
    // and a set that comes back short is a 404 (`mentionedTargets` in
    // `apps/api/src/mobile/libraryMentionLinks.ts`). A link the description holds
    // into some other library is not a row that lookup can find, which is why
    // the editor may only ever send [LibraryCharacter.characterMentions].
    for (final mentionId in mentionedCharacterIds ?? const <String>[]) {
      if (!_libraryCharacters.any((row) => row.id == mentionId)) {
        throw const ApiException(
          code: 'CHARACTER_NOT_FOUND',
          message: 'A mentioned character is no longer in your library.',
          statusCode: 404,
        );
      }
    }
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
                LibraryMention(
                  id: id,
                  name: id,
                  kind: LibraryMentionKind.character,
                ),
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
}
