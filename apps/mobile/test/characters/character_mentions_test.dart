import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/character_mentions.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

import 'character_test_support.dart';

void main() {
  final luna = testCharacter(id: 'luna', name: 'Luna');
  final vega = testCharacter(id: 'vega', name: 'Luna Vega');

  test('typed names resolve longest-first and in textual order', () {
    final mentions = resolveCharacterMentions(
      text: '@Luna Vega met @Luna.',
      inserted: const {},
      characters: [luna, vega],
    );
    expect([for (final mention in mentions) mention.id], ['vega', 'luna']);
  });

  test('ambiguous typed names require an explicit picked id', () {
    final otherLuna = testCharacter(id: 'other', name: 'luna');
    expect(
      resolveCharacterMentions(
        text: '@Luna',
        inserted: const {},
        characters: [luna, otherLuna],
      ),
      isEmpty,
    );
    expect(
      resolveCharacterMentions(
        text: '@Luna',
        inserted: const {'luna': '@Luna'},
        characters: [luna, otherLuna],
      ).single.id,
      'luna',
    );
  });

  test('the edited character is excluded from self mentions', () {
    expect(
      resolveCharacterMentions(
        text: '@Luna',
        inserted: const {},
        characters: [luna],
        excludeCharacterId: 'luna',
      ),
      isEmpty,
    );
  });

  test(
    'punctuation opens mentions and name punctuation stays in the token',
    () {
      final characters = [
        testCharacter(id: 'luna', name: 'Luna'),
        testCharacter(id: 'bear', name: 'Luna-Bear'),
      ];

      expect(
        [
          for (final mention in resolveCharacterMentions(
            text: '(@Luna), then @Luna-Bear.',
            inserted: const {},
            characters: characters,
          ))
            mention.id,
        ],
        ['luna', 'bear'],
      );
      expect(
        resolveCharacterMentions(
          text: 'mail@Luna.example',
          inserted: const {},
          characters: characters,
        ),
        isEmpty,
      );
      expect(
        resolveCharacterMentions(
          text: '𐐀@Luna',
          inserted: const {},
          characters: characters,
        ),
        isEmpty,
      );
    },
  );

  test('a possessive ends the token, straight quote or curly', () {
    // The composer prunes a tapped pick whose token it can no longer find, so
    // reading "@Luna's" as one word shipped the message with no character ids
    // and let the model invent the look this feature exists to pin.
    for (final text in ["@Luna's hat", '@Luna\u2019s hat']) {
      expect(characterTextHasMention(text, '@Luna'), isTrue);
      expect(
        resolveCharacterMentions(
          text: text,
          inserted: const {'luna': '@Luna'},
          characters: [luna],
        ).single.id,
        'luna',
      );
    }
  });

  test('a hyphen joining the next word binds nobody', () {
    // The build sweep agrees (`creationBuild.ts`): the composer showed no chip
    // for "@Luna-Bear" while the server bound Luna behind it and snapshotted
    // her face onto a character the reader never named.
    expect(
      resolveCharacterMentions(
        text: 'A story about @Luna-Bear',
        inserted: const {},
        characters: [luna],
      ),
      isEmpty,
    );
    expect(characterTextHasMention('A story about @Luna-Bear', '@Luna'), isFalse);

    // The saved name may own the hyphen, and a hyphen joining nothing is
    // ordinary punctuation.
    final bear = testCharacter(id: 'bear', name: 'Luna-Bear');
    expect(
      resolveCharacterMentions(
        text: 'A story about @Luna-Bear',
        inserted: const {},
        characters: [luna, bear],
      ).single.id,
      'bear',
    );
    for (final text in ['@Luna-', '@Luna - the rabbit']) {
      expect(
        resolveCharacterMentions(
          text: text,
          inserted: const {},
          characters: [luna],
        ).single.id,
        'luna',
      );
    }
  });

  test('a ZWNJ joins a Persian name into one token', () {
    // «علی‌رضا» is one name written with a zero-width non-joiner. ZWNJ is
    // category `Cf`, so a boundary class that stops at letters alone reads it
    // as a word break and hands one saved character's face to another.
    const ali = '\u0639\u0644\u06cc';
    const alireza = '\u0639\u0644\u06cc\u200c\u0631\u0636\u0627';
    const text = '\u0647\u0645\u0631\u0627\u0647 @$alireza';
    final short = testCharacter(id: 'ali', name: ali);
    final long = testCharacter(id: 'alireza', name: alireza);

    expect(
      resolveCharacterMentions(
        text: text,
        inserted: const {},
        characters: [short],
      ),
      isEmpty,
    );
    expect(
      resolveCharacterMentions(
        text: text,
        inserted: const {},
        characters: [short, long],
      ).single.id,
      'alireza',
    );
    expect(
      savedCharacterMentionRanges(text, [
        CharacterMention(id: 'ali', name: ali),
        CharacterMention(id: 'alireza', name: alireza),
      ]).single.mention.id,
      'alireza',
    );
  });

  test('saved ranges leave a nested name inside the longer one alone', () {
    final ranges = savedCharacterMentionRanges('@Luna and @Luna Vega', const [
      CharacterMention(id: 'luna', name: 'Luna'),
      CharacterMention(id: 'vega', name: 'Luna Vega'),
    ]);

    expect(
      [for (final range in ranges) (range.mention.id, range.start, range.end)],
      [('luna', 0, 5), ('vega', 10, 20)],
    );
  });

  test('two names differing only in case keep their own tokens', () {
    final ranges = savedCharacterMentionRanges('@Bram met @bram.', const [
      CharacterMention(id: 'upper', name: 'Bram'),
      CharacterMention(id: 'lower', name: 'bram'),
    ]);

    expect(
      [for (final range in ranges) (range.mention.id, range.start)],
      [('upper', 0), ('lower', 10)],
    );
  });

  test('an eleventh mention comes back over-full rather than trimmed', () {
    // The editor's Save sends the resolved set as the authoritative one, so a
    // set quietly trimmed to a legal-looking ten deleted a durable link whose
    // "@Name" was still in the prose. Over the cap it stays over the cap, and
    // the caller refuses it.
    final characters = [
      for (var index = 0; index < 11; index += 1)
        testCharacter(id: 'char-$index', name: 'Name$index'),
    ];
    final text = [for (final character in characters) '@${character.name}']
        .join(' and ');

    final resolved = resolveCharacterMentions(
      text: text,
      inserted: const {},
      characters: characters,
    );

    expect(resolved.length, greaterThan(10));
    expect(resolved.last.id, 'char-10');
  });
}
