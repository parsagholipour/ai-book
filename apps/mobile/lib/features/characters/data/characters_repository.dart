import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';

/// What `POST /:id/portrait` answered with: the character (now queued) and the
/// credits reserved for the drawing.
typedef CharacterPortraitStart = ({
  LibraryCharacter character,
  int creditsCharged,
});

/// A character and its retained pictures, as every write that can move a
/// pointer answers: one response re-renders every surface.
typedef CharacterImages = ({
  LibraryCharacter character,
  List<CharacterImage> images,
});

abstract interface class CharactersRepository {
  Future<CharacterLibrary> list();

  Future<LibraryCharacter> create({
    required String name,
    String description = '',
    List<CharacterField> fields = const [],
    List<String> mentionedCharacterIds = const [],
  });

  /// Partial update: only non-null arguments travel, and the API requires at
  /// least one of them. [dismissSuggestion] counts as one on its own — turning
  /// down the description read off the photo is a change like any other.
  Future<LibraryCharacter> update({
    required String id,
    String? name,
    String? description,
    List<CharacterField>? fields,
    List<String>? mentionedCharacterIds,
    bool? dismissSuggestion,
  });

  Future<void> delete(String id);

  Future<LibraryCharacter> uploadPhoto({
    required String id,
    required String filename,
    required List<int> bytes,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
  });

  Future<LibraryCharacter> deletePhoto(String id);

  /// Every retained picture for one character, newest first.
  Future<List<CharacterImage>> images(String id);

  /// Makes one retained picture the character's main image. Free — nothing
  /// here reserves or spends a credit.
  ///
  /// Answers with the character *and* its pictures, because the two are only
  /// meaningful together: `isMain` and the capability flags are statements
  /// about a picture relative to the character's current pointers.
  Future<CharacterImages> promoteImage({
    required String id,
    required String imageId,
  });

  Future<CharacterImages> deleteImage({
    required String id,
    required String imageId,
  });

  Future<CharacterPortraitStart> generatePortrait({
    required String id,
    String? requestId,
  });

  /// Auth headers for [LibraryCharacter.photoUrl]/[LibraryCharacter.portraitUrl]
  /// images, which are served behind the mobile bearer token.
  Future<Map<String, String>> assetHeaders();
}

class MobileCharactersRepository implements CharactersRepository {
  const MobileCharactersRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<CharacterLibrary> list() async {
    final data = await apiClient.getMap('/api/mobile/characters');
    return CharacterLibrary.fromJson(data);
  }

  @override
  Future<LibraryCharacter> create({
    required String name,
    String description = '',
    List<CharacterField> fields = const [],
    List<String> mentionedCharacterIds = const [],
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/characters',
      data: <String, dynamic>{
        'name': name,
        'description': description,
        'fields': [for (final field in fields) field.toJson()],
        'mentionedCharacterIds': mentionedCharacterIds,
      },
    );
    return _characterFrom(data);
  }

  @override
  Future<LibraryCharacter> update({
    required String id,
    String? name,
    String? description,
    List<CharacterField>? fields,
    List<String>? mentionedCharacterIds,
    bool? dismissSuggestion,
  }) async {
    final response = await apiClient.patchJson(
      '/api/mobile/characters/$id',
      data: <String, dynamic>{
        'name': ?name,
        'description': ?description,
        if (fields != null)
          'fields': [for (final field in fields) field.toJson()],
        'mentionedCharacterIds': ?mentionedCharacterIds,
        'dismissSuggestion': ?dismissSuggestion,
      },
    );
    return _characterFrom(response.data as Map<String, dynamic>);
  }

  @override
  Future<void> delete(String id) async {
    await apiClient.deleteJson('/api/mobile/characters/$id');
  }

  @override
  Future<LibraryCharacter> uploadPhoto({
    required String id,
    required String filename,
    required List<int> bytes,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
  }) async {
    final response = await apiClient.putBytes(
      '/api/mobile/characters/$id/photo',
      bytes: bytes,
      queryParameters: {
        'filename': filename,
        if (mimeType != null && mimeType.isNotEmpty) 'mimeType': mimeType,
      },
      onSendProgress: onProgress,
    );
    return _characterFrom(response.data as Map<String, dynamic>);
  }

  @override
  Future<List<CharacterImage>> images(String id) async {
    final data = await apiClient.getMap('/api/mobile/characters/$id/images');
    return CharacterImage.listFromJson(data['images']);
  }

  @override
  Future<CharacterImages> promoteImage({
    required String id,
    required String imageId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/characters/$id/images/$imageId/promote',
    );
    return _characterImagesFrom(data);
  }

  @override
  Future<CharacterImages> deleteImage({
    required String id,
    required String imageId,
  }) async {
    final response = await apiClient.deleteJson(
      '/api/mobile/characters/$id/images/$imageId',
    );
    return _characterImagesFrom(response.data as Map<String, dynamic>);
  }

  @override
  Future<LibraryCharacter> deletePhoto(String id) async {
    final response = await apiClient.deleteJson(
      '/api/mobile/characters/$id/photo',
    );
    return _characterFrom(response.data as Map<String, dynamic>);
  }

  @override
  Future<CharacterPortraitStart> generatePortrait({
    required String id,
    String? requestId,
  }) async {
    final data = await apiClient.postMap(
      '/api/mobile/characters/$id/portrait',
      data: <String, dynamic>{'requestId': ?requestId},
    );
    return (
      character: LibraryCharacter.fromJson(
        data['character'] as Map<String, dynamic>,
      ),
      creditsCharged: data['creditsCharged'] as int? ?? 0,
    );
  }

  @override
  Future<Map<String, String>> assetHeaders() {
    return apiClient.authHeaders();
  }

  LibraryCharacter _characterFrom(Map<String, dynamic> data) {
    return LibraryCharacter.fromJson(data['character'] as Map<String, dynamic>);
  }

  CharacterImages _characterImagesFrom(Map<String, dynamic> data) {
    return (
      character: LibraryCharacter.fromJson(
        data['character'] as Map<String, dynamic>,
      ),
      images: CharacterImage.listFromJson(data['images']),
    );
  }
}

final charactersRepositoryProvider = Provider<CharactersRepository>((ref) {
  return MobileCharactersRepository(apiClient: ref.watch(apiClientProvider));
});

/// The signed-in user's character library.
///
/// `autoDispose`, unlike `projectsProvider`: nothing outside the library
/// surfaces holds this open, and dropping it when the last screen closes is
/// also what keeps one account's characters from surviving sign-out into the
/// next session — this feature wires no logout invalidation of its own.
final charactersProvider = FutureProvider.autoDispose<CharacterLibrary>((ref) {
  return ref.watch(charactersRepositoryProvider).list();
});

/// Auth headers for the character image routes, resolved once per watcher the
/// same way `projectAssetHeadersProvider` does for project assets.
final characterAssetHeadersProvider =
    FutureProvider.autoDispose<Map<String, String>>((ref) {
      return ref.watch(charactersRepositoryProvider).assetHeaders();
    });

/// One character's retained pictures.
///
/// Deliberately its own request rather than a field on [LibraryCharacter]:
/// `GET /api/mobile/characters` stays image-free, because a hundred characters
/// times twenty pictures is a payload nothing on the list screen would draw.
/// It also means the strip survives the library's 3-second poll, which
/// invalidates [charactersProvider] and would otherwise wipe the pictures a
/// mutation response had just put in state.
final characterImagesProvider = FutureProvider.autoDispose
    .family<List<CharacterImage>, String>((ref, id) {
      return ref.watch(charactersRepositoryProvider).images(id);
    });
