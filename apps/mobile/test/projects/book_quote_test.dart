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
    // Balanced, drawn cover: base + pages, a picture a page up to 12, then 12
    // spread across the book. No export line, whoever approves it.
    expect(kids(12), 350 + 12 * 8 + 12 * 45 + 45);
    expect(kids(16), 350 + 16 * 8 + 12 * 45 + 45);
    expect(kids(24), 350 + 24 * 8 + 12 * 45 + 45);
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

  test('a picture book draws min(pages, 12) pictures', () {
    // min(pages, 12), as core's freeBookQuote.test.ts spells it: a longer book
    // never draws fewer (13 pages used to draw 7).
    const table = {
      1: 1,
      5: 5,
      11: 11,
      12: 12,
      13: 12,
      14: 12,
      16: 12,
      20: 12,
      22: 12,
      23: 12,
      24: 12,
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
  });
}
