import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/studio_pricing.dart';

// Totals are spelled out rather than derived from the rate table, the same
// way the server's tests spell them, so a drift on either side fails here.
void main() {
  const costs = <String, dynamic>{};

  int price(LongAssistKind kind, String tier, {int? words, int chars = 0}) =>
      estimateStudioAssistCredits(
        kind: kind,
        qualityPreset: tier,
        creditCosts: costs,
        targetWords: words,
        chapterChars: chars,
      );

  test('an illustration costs one image at the tier', () {
    expect(price(LongAssistKind.illustrate, 'balanced'), 45);
    expect(price(LongAssistKind.illustrate, 'premium'), 85);
  });

  test('a chapter draft costs its estimated pages', () {
    expect(price(LongAssistKind.draftChapter, 'balanced'), 5 * 80);
    expect(price(LongAssistKind.draftChapter, 'fast', words: 300), 40);
    expect(price(LongAssistKind.draftChapter, 'ultra', words: 20000), 15 * 280);
  });

  test('chapter feedback costs a base plus the pages it reads', () {
    expect(price(LongAssistKind.chapterFeedback, 'balanced', chars: 0), 35);
    expect(price(LongAssistKind.chapterFeedback, 'balanced', chars: 3801), 55);
    expect(price(LongAssistKind.chapterFeedback, 'premium', chars: 1900), 53);
  });

  test('the consistency check and the outline', () {
    expect(price(LongAssistKind.consistency, 'fast'), 200);
    expect(price(LongAssistKind.outline, 'balanced'), 40);
    expect(price(LongAssistKind.outline, 'ultra'), 120);
  });

  test('operator overrides are read', () {
    expect(
      estimateStudioAssistCredits(
        kind: LongAssistKind.illustrate,
        qualityPreset: 'balanced',
        creditCosts: const {'imageGeneration': 60},
      ),
      60,
    );
    expect(estimateStudioCoverCredits(const {'coverRegeneration': 99}), 99);
    expect(estimateStudioCoverCredits(const {}), 120);
  });
}
