import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/making_of_models.dart';
import 'package:tomeza/features/projects/presentation/behind_the_book.dart';

void main() {
  test('reads the making-of wire, leaving out what cannot be opened', () {
    final makingOf = MobileMakingOf.fromJson({
      'cast': [
        {
          'id': 'voice-1',
          'name': 'Neymar',
          'role': 'Male lead',
          'status': 'ready',
        },
      ],
      'chapters': [
        {
          'index': 1,
          'title': ' The Table ',
          'summary': '',
          'firstPageIndex': 1,
        },
        {
          'index': 2,
          'title': 'The Door',
          'summary': 'Phones.',
          'firstPageIndex': 3,
        },
        {'index': 3, 'title': 'Empty', 'summary': '', 'firstPageIndex': null},
      ],
      'sources': [
        {'title': 'si.com', 'host': 'si.com', 'url': 'https://www.si.com/a'},
        {
          'title': 'Neymargate',
          'host': 'en.wikipedia.org',
          'url': 'https://en.wikipedia.org/wiki/Neymargate',
        },
        {'title': 'Script', 'host': null, 'url': 'javascript:alert(1)'},
      ],
      'sourceCount': 9,
    });

    expect(makingOf.cast.single.name, 'Neymar');
    expect(makingOf.readableChapters.map((chapter) => chapter.title), [
      'The Table',
      'The Door',
    ]);
    expect(makingOf.sources.map((source) => source.title), [
      'si.com',
      'Neymargate',
    ]);
    // A title that is the site is not repeated under itself.
    expect(makingOf.sources.first.subtitle, isNull);
    expect(makingOf.sources.last.subtitle, 'en.wikipedia.org');
    expect(makingOfTeaser(makingOf), '1 character · 2 chapters · 9 sources');
  });

  test('a book of one chapter and nothing else has nothing behind it', () {
    final makingOf = MobileMakingOf.fromJson({
      'chapters': [
        {'index': 1, 'title': 'All of it', 'summary': '', 'firstPageIndex': 1},
      ],
    });

    expect(makingOf.readableChapters, isEmpty);
    expect(makingOf.isEmpty, isTrue);
    expect(makingOfTeaser(makingOf), isNull);
    // An older server sends none of the keys.
    expect(MobileMakingOf.fromJson(const {}).isEmpty, isTrue);
  });

  test('the timing line adds the planning, or says nothing', () {
    expect(
      makingOfTimingLine(planningMs: 72000, bookMs: 99000),
      'Planned in 1m 12s, written in 1m 39s.',
    );
    expect(makingOfTimingLine(planningMs: 40000), 'Planned in 40s.');
    // The card's facts already say how long the writing took.
    expect(makingOfTimingLine(bookMs: 99000), isNull);
  });

  test('a chapter opens at its sheet only beside the digest it belongs to', () {
    const chapter = MakingOfChapter(
      index: 2,
      title: 'A Chance to Listen',
      firstPageIndex: 4,
      pdfPage: 7,
    );

    expect(
      readerLocationForChapter('p', chapter, 'abc'),
      '/projects/p/read?page=4&sheet=7&digest=abc',
    );
    expect(
      readerLocationForChapter('p', chapter, null),
      '/projects/p/read?page=4',
    );
    expect(
      readerLocationForChapter(
        'p',
        const MakingOfChapter(index: 1, title: 'T', firstPageIndex: 1),
        'abc',
      ),
      '/projects/p/read?page=1',
    );
  });
}
