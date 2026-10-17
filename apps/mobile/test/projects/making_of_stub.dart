import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/projects/data/making_of_repository.dart';
import 'package:tomeza/features/projects/domain/making_of_models.dart';

/// "Behind the book" without a network: answers [makingOf] for every book and
/// remembers which books were asked about.
class StubMakingOfRepository implements MakingOfRepository {
  StubMakingOfRepository([this.makingOf = MobileMakingOf.empty]);

  final MobileMakingOf makingOf;
  final List<String> reads = [];

  @override
  Future<MobileMakingOf> getMakingOf(String projectId) async {
    reads.add(projectId);
    return makingOf;
  }
}

/// The reader's saved characters, and nothing else a character surface could
/// ask for: "Behind the book" only reads the list, to tell a cast member the
/// reader already saved from one they have not.
class LibraryOnlyCharactersRepository implements CharactersRepository {
  LibraryOnlyCharactersRepository([this.characters = const []]);

  final List<LibraryCharacter> characters;

  @override
  Future<CharacterLibrary> list() async =>
      CharacterLibrary(characters: characters);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
