import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

/// One library character, with only what the Studio's cast reads spelled out.
LibraryCharacter studioCharacter({
  required String id,
  required String name,
  String description = '',
}) {
  return LibraryCharacter(
    id: id,
    name: name,
    description: description,
    createdAt: DateTime.utc(2026, 8, 1),
    updatedAt: DateTime.utc(2026, 8, 1),
  );
}

/// The author's character library, as the Studio's cast sees it: a list, and
/// a way to add to it. Everything else a character screen would do is out of
/// the cast's reach, so it is not implemented here.
class FakeStudioCharacters implements CharactersRepository {
  FakeStudioCharacters({List<LibraryCharacter>? characters})
    : characters = characters ?? [];

  final List<LibraryCharacter> characters;

  /// The ids of the characters [create] made, in order.
  final List<String> created = [];

  @override
  Future<CharacterLibrary> list() async =>
      CharacterLibrary(characters: List.of(characters));

  @override
  Future<LibraryCharacter> create({
    required String name,
    String description = '',
    List<CharacterField> fields = const [],
    List<String> mentionedCharacterIds = const [],
  }) async {
    final character = studioCharacter(
      id: 'char-new-${created.length + 1}',
      name: name,
      description: description,
    );
    characters.add(character);
    created.add(character.id);
    return character;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} is not faked');
}
