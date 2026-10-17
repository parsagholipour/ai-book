import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

/// The app's twin of core's `estimateFullBookCreditCost`. A book is one
/// charge, taken at plan approval, and its finished file downloads free, so no
/// quote carries an export line — for a free reader or a paid one. Spelled
/// out, never derived from the price table, as
/// `packages/core/src/freeBookQuote.test.ts` spells the same totals: there is
/// no server quote route behind this number.
void main() {
  int quote({
    required String bookType,
    required String bookTypeChoice,
    required int pages,
    bool illustrated = true,
    Map<String, dynamic> creditCosts = const {},
  }) => estimateProjectCredits(
    bookType: bookType,
    bookTypeChoice: bookTypeChoice,
    qualityPreset: 'balanced',
    coverEnabled: illustrated,
    illustrationsEnabled: illustrated,
    targetPages: pages,
    creditCosts: creditCosts,
  );

  int kids(int pages, {Map<String, dynamic> creditCosts = const {}}) => quote(
    bookType: 'short_story',
    bookTypeChoice: 'children_story',
    pages: pages,
    creditCosts: creditCosts,
  );

  test('a picture book is priced as its writing and pictures alone', () {
    // Balanced, drawn cover: base + pages, two pictures for every five pages,
    // at most 12. No export line, whoever approves it.
    expect(kids(5), 350 + 5 * 8 + 2 * 45 + 45);
    expect(kids(10), 350 + 10 * 8 + 4 * 45 + 45);
    expect(kids(12), 350 + 12 * 8 + 5 * 45 + 45);
    expect(kids(16), 350 + 16 * 8 + 6 * 45 + 45);
    expect(kids(24), 350 + 24 * 8 + 10 * 45 + 45);
    expect(kids(30), 350 + 30 * 8 + 12 * 45 + 45);
  });

  test('a 30-page story is priced the same way', () {
    int story({required bool illustrated}) => quote(
      bookType: 'short_story',
      bookTypeChoice: 'short_story',
      pages: 30,
      illustrated: illustrated,
    );
    expect(story(illustrated: false), 350 + 30 * 8);
    // Pages 1, 8, 16 and 24, and a drawn cover.
    expect(story(illustrated: true), 350 + 30 * 8 + 4 * 45 + 45);
  });

  test('a price list that still names the old unlock adds nothing', () {
    // The server sends `exportUnlock: 0` now, and the key may stay; even a
    // stored 150 is never part of a book's price.
    expect(kids(12, creditCosts: const {'exportUnlock': 150}), kids(12));
    expect(kids(12, creditCosts: const {'exportUnlock': 0}), kids(12));
  });

  test('a picture book draws two pictures for every five pages', () {
    // Rounded to the nearest, at least 1 and at most 12, as core's
    // freeBookQuote.test.ts spells it.
    const table = {
      1: 1,
      2: 1,
      3: 1,
      4: 2,
      5: 2,
      8: 3,
      9: 4,
      10: 4,
      11: 4,
      12: 5,
      13: 5,
      16: 6,
      20: 8,
      24: 10,
      28: 11,
      29: 12,
      30: 12,
      40: 12,
    };
    for (final MapEntry(key: pages, value: pictures) in table.entries) {
      expect(
        pictureBookIllustrationCount(pages),
        pictures,
        reason: '$pages pages',
      );
    }
    expect(pictureBookIllustrationCount(0), 0);
    // A longer book never draws fewer (13 pages once drew 7 where 12 drew 12).
    for (var pages = 1; pages <= 600; pages++) {
      expect(
        pictureBookIllustrationCount(pages),
        greaterThanOrEqualTo(pictureBookIllustrationCount(pages - 1)),
        reason: '$pages pages',
      );
    }
  });
}
