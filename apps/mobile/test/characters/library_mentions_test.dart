import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/library_mentions.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

import 'character_test_support.dart';

void main() {
  final luna = testCharacter(id: 'luna', name: 'Luna');
  final vega = testCharacter(id: 'vega', name: 'Luna Vega');

  test('typed names resolve longest-first and in textual order', () {
    final mentions = resolveLibraryMentions(
      text: '@Luna Vega met @Luna.',
      inserted: const {},
      characters: [luna, vega],
    );
    expect([for (final mention in mentions) mention.id], ['vega', 'luna']);
  });

  test('ambiguous typed names require an explicit picked id', () {
    final otherLuna = testCharacter(id: 'other', name: 'luna');
    expect(
      resolveLibraryMentions(
        text: '@Luna',
        inserted: const {},
        characters: [luna, otherLuna],
      ),
      isEmpty,
    );
    expect(
      resolveLibraryMentions(
        text: '@Luna',
        inserted: const {'luna': '@Luna'},
        characters: [luna, otherLuna],
      ).single.id,
      'luna',
    );
  });

  test('the edited character is excluded from self mentions', () {
    expect(
      resolveLibraryMentions(
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
          for (final mention in resolveLibraryMentions(
            text: '(@Luna), then @Luna-Bear.',
            inserted: const {},
            characters: characters,
          ))
            mention.id,
        ],
        ['luna', 'bear'],
      );
      expect(
        resolveLibraryMentions(
          text: 'mail@Luna.example',
          inserted: const {},
          characters: characters,
        ),
        isEmpty,
      );
      expect(
        resolveLibraryMentions(
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
      expect(libraryTextHasMention(text, '@Luna'), isTrue);
      expect(
        resolveLibraryMentions(
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
      resolveLibraryMentions(
        text: 'A story about @Luna-Bear',
        inserted: const {},
        characters: [luna],
      ),
      isEmpty,
    );
    expect(libraryTextHasMention('A story about @Luna-Bear', '@Luna'), isFalse);

    // The saved name may own the hyphen, and a hyphen joining nothing is
    // ordinary punctuation.
    final bear = testCharacter(id: 'bear', name: 'Luna-Bear');
    expect(
      resolveLibraryMentions(
        text: 'A story about @Luna-Bear',
        inserted: const {},
        characters: [luna, bear],
      ).single.id,
      'bear',
    );
    for (final text in ['@Luna-', '@Luna - the rabbit']) {
      expect(
        resolveLibraryMentions(
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
      resolveLibraryMentions(
        text: text,
        inserted: const {},
        characters: [short],
      ),
      isEmpty,
    );
    expect(
      resolveLibraryMentions(
        text: text,
        inserted: const {},
        characters: [short, long],
      ).single.id,
      'alireza',
    );
    expect(
      savedLibraryMentionRanges(text, [
        LibraryMention(id: 'ali', name: ali),
        LibraryMention(id: 'alireza', name: alireza),
      ]).single.mention.id,
      'alireza',
    );
  });

  test('saved ranges leave a nested name inside the longer one alone', () {
    final ranges = savedLibraryMentionRanges('@Luna and @Luna Vega', const [
      LibraryMention(id: 'luna', name: 'Luna'),
      LibraryMention(id: 'vega', name: 'Luna Vega'),
    ]);

    expect(
      [for (final range in ranges) (range.mention.id, range.start, range.end)],
      [('luna', 0, 5), ('vega', 10, 20)],
    );
  });

  test('two names differing only in case keep their own tokens', () {
    final ranges = savedLibraryMentionRanges('@Bram met @bram.', const [
      LibraryMention(id: 'upper', name: 'Bram'),
      LibraryMention(id: 'lower', name: 'bram'),
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
    final text = [
      for (final character in characters) '@${character.name}',
    ].join(' and ');

    final resolved = resolveLibraryMentions(
      text: text,
      inserted: const {},
      characters: characters,
    );

    expect(resolved.length, greaterThan(10));
    expect(resolved.last.id, 'char-10');
  });

  test('the over-full set is exactly one sentinel past the limit', () {
    // Pinned, because both callers do arithmetic on it: the editor sizes its
    // chip row from the returned length and the composer drops down to its own
    // cap. A second element past the limit is a chip nobody asked for.
    final characters = [
      for (var index = 0; index < 12; index += 1)
        testCharacter(id: 'char-$index', name: 'Name$index'),
    ];
    final text = [
      for (final character in characters) '@${character.name}',
    ].join(' and ');

    expect(
      resolveLibraryMentions(
        text: text,
        inserted: const {},
        characters: characters,
        limit: 10,
      ),
      hasLength(11),
    );
    expect(
      resolveLibraryMentions(
        text: text,
        inserted: const {},
        characters: characters,
        limit: 3,
      ),
      hasLength(4),
    );
  });

  test('a resolved mention carries the character kind', () {
    // Only character rows are written today, and the resolver only ever reads
    // the character library — so anything it hands back is a character link,
    // and the editor's chips and its save both rely on that.
    expect(
      resolveLibraryMentions(
        text: '@Luna',
        inserted: const {},
        characters: [luna],
      ).single.kind,
      LibraryMentionKind.character,
    );
  });
}
