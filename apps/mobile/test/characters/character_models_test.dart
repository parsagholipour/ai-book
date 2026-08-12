import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

Map<String, dynamic> characterJson({
  String id = 'char-1',
  String name = 'Mina Park',
  String description = 'Brave, curious, always muddy.',
  Object? fields = const [
    {'key': 'Age', 'value': '9'},
    {'key': 'Likes', 'value': 'thunderstorms'},
  ],
  String portraitStatus = 'none',
  String? portraitError,
  String? portraitSource,
  bool hasPhoto = false,
  String? photoKind,
  String? suggestedDescription,
  bool usedInBooks = false,
  String? photoUrl,
  String? portraitUrl,
}) {
  return {
    'id': id,
    'name': name,
    'description': description,
    'fields': fields,
    'portraitStatus': portraitStatus,
    'portraitError': portraitError,
    'portraitSource': portraitSource,
    'hasPhoto': hasPhoto,
    'photoKind': photoKind,
    'suggestedDescription': suggestedDescription,
    'usedInBooks': usedInBooks,
    'photoUrl': photoUrl,
    'portraitUrl': portraitUrl,
    'createdAt': '2026-08-01T10:00:00.000Z',
    'updatedAt': '2026-08-02T11:30:00.000Z',
  };
}

LibraryCharacter character({
  String name = 'Mina Park',
  String portraitStatus = 'none',
}) {
  return LibraryCharacter.fromJson(
    characterJson(name: name, portraitStatus: portraitStatus),
  );
}

void main() {
  group('LibraryCharacter JSON', () {
    test('round-trips through fromJson and toJson', () {
      final json = characterJson(
        portraitStatus: 'failed',
        portraitError: 'The provider refused.',
        hasPhoto: true,
        photoKind: 'photograph',
        suggestedDescription: 'A girl in a yellow raincoat.',
        photoUrl: '/api/mobile/characters/char-1/photo',
      );

      final parsed = LibraryCharacter.fromJson(json);

      expect(parsed.id, 'char-1');
      expect(parsed.name, 'Mina Park');
      expect(parsed.fields, hasLength(2));
      expect(parsed.fields.first.key, 'Age');
      expect(parsed.fields.first.value, '9');
      expect(parsed.portraitStatus, CharacterPortraitStatus.failed);
      expect(parsed.portraitError, 'The provider refused.');
      expect(parsed.hasPhoto, isTrue);
      expect(parsed.photoKind, CharacterPhotoKind.photograph);
      expect(parsed.suggestedDescription, 'A girl in a yellow raincoat.');
      expect(parsed.usedInBooks, isFalse);
      expect(parsed.updatedAt, DateTime.utc(2026, 8, 2, 11, 30));
      expect(parsed.toJson(), json);
    });

    test('an adopted upload round-trips its wire spelling', () {
      final json = characterJson(
        portraitStatus: 'ready',
        portraitSource: 'adopted_upload',
        hasPhoto: true,
        photoKind: 'illustration',
        usedInBooks: true,
        portraitUrl: '/api/mobile/characters/char-1/portrait',
      );

      final parsed = LibraryCharacter.fromJson(json);

      expect(parsed.portraitSource, CharacterPortraitSource.adoptedUpload);
      expect(parsed.usedInBooks, isTrue);
      expect(parsed.toJson(), json);
    });

    test('unknown photo kinds and portrait sources read as null', () {
      // An older client must survive a newer server naming a case it has
      // never heard of, rather than guessing one.
      final parsed = LibraryCharacter.fromJson(
        characterJson(photoKind: 'hologram', portraitSource: 'handmade'),
      );

      expect(parsed.photoKind, isNull);
      expect(parsed.portraitSource, isNull);
    });

    group('needsCartoonReference', () {
      test('a stored photograph the books cannot use yet', () {
        final parsed = LibraryCharacter.fromJson(
          characterJson(hasPhoto: true, photoKind: 'photograph'),
        );
        expect(parsed.needsCartoonReference, isTrue);
      });

      test('adopted artwork already reaches the book', () {
        final parsed = LibraryCharacter.fromJson(
          characterJson(
            hasPhoto: true,
            photoKind: 'illustration',
            portraitStatus: 'ready',
            portraitSource: 'adopted_upload',
            usedInBooks: true,
          ),
        );
        expect(parsed.needsCartoonReference, isFalse);
      });

      test('a photo that was never read still counts as owed', () {
        // No verdict is not permission to stay quiet: the book gets nothing
        // either way, and saying so is the honest state.
        final parsed = LibraryCharacter.fromJson(characterJson(hasPhoto: true));
        expect(parsed.needsCartoonReference, isTrue);
      });

      test('an illustration that was not adopted owes the same step', () {
        final parsed = LibraryCharacter.fromJson(
          characterJson(hasPhoto: true, photoKind: 'illustration'),
        );
        expect(parsed.needsCartoonReference, isTrue);
      });

      test('nothing is owed while the drawing is already being made', () {
        final parsed = LibraryCharacter.fromJson(
          characterJson(hasPhoto: true, portraitStatus: 'generating'),
        );
        expect(parsed.needsCartoonReference, isFalse);
      });

      test('no photo at all is not an unfinished one', () {
        expect(
          LibraryCharacter.fromJson(characterJson()).needsCartoonReference,
          isFalse,
        );
      });
    });

    test('drops malformed field entries instead of rendering blanks', () {
      final parsed = LibraryCharacter.fromJson(
        characterJson(
          fields: [
            {'key': 'Age', 'value': '9'},
            {'key': 'no value'},
            {'value': 'no key'},
            'not a map',
            null,
            {'key': 7, 'value': 'non-string key'},
          ],
        ),
      );

      expect(parsed.fields, hasLength(1));
      expect(parsed.fields.single.key, 'Age');
    });

    test('a fields payload that is not a list reads as no fields', () {
      final parsed = LibraryCharacter.fromJson(
        characterJson(fields: {'key': 'Age', 'value': '9'}),
      );

      expect(parsed.fields, isEmpty);
    });

    test('an unknown portrait status reads as none', () {
      expect(
        character(portraitStatus: 'sketching').portraitStatus,
        CharacterPortraitStatus.none,
      );
    });
  });

  group('CharacterPortraitStatus', () {
    test('maps every wire value both ways', () {
      for (final status in CharacterPortraitStatus.values) {
        expect(CharacterPortraitStatus.fromWire(status.wire), status);
      }
    });

    test('only queued and generating are busy', () {
      expect(CharacterPortraitStatus.queued.isBusy, isTrue);
      expect(CharacterPortraitStatus.generating.isBusy, isTrue);
      expect(CharacterPortraitStatus.none.isBusy, isFalse);
      expect(CharacterPortraitStatus.ready.isBusy, isFalse);
      expect(CharacterPortraitStatus.failed.isBusy, isFalse);
    });
  });

  group('initials', () {
    String initialsOf(String name) => character(name: name).initials;

    test('empty and whitespace-only names fall back to ?', () {
      expect(initialsOf(''), '?');
      expect(initialsOf('   '), '?');
    });

    test('a single word gives one upper-cased letter', () {
      expect(initialsOf('nova'), 'N');
    });

    test('two words give first and last', () {
      expect(initialsOf('Mina Park'), 'MP');
      expect(initialsOf('ana maria rey'), 'AR');
    });

    test('an emoji is kept whole, never split into code units', () {
      expect(initialsOf('🦊'), '🦊');
      expect(initialsOf('🦊 Fox'), '🦊F');
    });

    test('a zero-width-joiner emoji sequence stays one grapheme', () {
      // Woman astronaut: woman + ZWJ + rocket - three code points, one glyph.
      const astronaut = '\u{1F469}\u{200D}\u{1F680}';
      expect(initialsOf('$astronaut Alma'), '${astronaut}A');
    });

    test('a surrogate-pair letter is kept whole', () {
      // Mathematical double-struck M, U+1D544 - two UTF-16 code units.
      expect(initialsOf('\u{1D544}arta'), '\u{1D544}');
    });

    test('a combining mark travels with its base letter', () {
      // 'e' + U+0301 combining acute; upper-casing keeps the decomposed form.
      expect(initialsOf('e\u0301lodie'), 'E\u0301');
    });
  });

  group('copyWith', () {
    test('keeps nullable fields unless explicitly replaced', () {
      final failed = LibraryCharacter.fromJson(
        characterJson(
          portraitStatus: 'failed',
          portraitError: 'The provider refused.',
        ),
      );

      final untouched = failed.copyWith(name: 'Nova');
      expect(untouched.name, 'Nova');
      expect(untouched.portraitError, 'The provider refused.');

      final cleared = failed.copyWith(
        portraitStatus: CharacterPortraitStatus.queued,
        portraitError: null,
      );
      expect(cleared.portraitStatus, CharacterPortraitStatus.queued);
      expect(cleared.portraitError, isNull);
    });
  });

  group('CharacterLibrary', () {
    test('parses characters and the portrait price', () {
      final library = CharacterLibrary.fromJson({
        'characters': [characterJson(), characterJson(id: 'char-2')],
        'portraitCredits': 40,
      });

      expect(library.characters, hasLength(2));
      expect(library.portraitCredits, 40);
      expect(library.hasBusyPortrait, isFalse);
    });

    test('reports a busy portrait anywhere in the list', () {
      final library = CharacterLibrary.fromJson({
        'characters': [
          characterJson(),
          characterJson(id: 'char-2', portraitStatus: 'generating'),
        ],
        'portraitCredits': 40,
      });

      expect(library.hasBusyPortrait, isTrue);
    });

    test('a missing characters key reads as an empty library', () {
      final library = CharacterLibrary.fromJson(const {'portraitCredits': 40});

      expect(library.characters, isEmpty);
    });
  });

  test('displayImageUrl prefers the portrait over the photo', () {
    final both = LibraryCharacter.fromJson(
      characterJson(
        portraitStatus: 'ready',
        hasPhoto: true,
        photoUrl: '/api/mobile/characters/char-1/photo',
        portraitUrl: '/api/mobile/characters/char-1/portrait',
      ),
    );
    expect(both.displayImageUrl, '/api/mobile/characters/char-1/portrait');

    final photoOnly = LibraryCharacter.fromJson(
      characterJson(
        hasPhoto: true,
        photoUrl: '/api/mobile/characters/char-1/photo',
      ),
    );
    expect(photoOnly.displayImageUrl, '/api/mobile/characters/char-1/photo');

    expect(character().displayImageUrl, isNull);
  });
}
