/// What the Writing Studio's paid AI tools cost — the app's mirror of the
/// server's assist pricing (`.scratch/writing-studio/spec.md`, "Phase 2 + 3
/// contract"). Like every quote in the app it has no server route behind it,
/// so the two sides spell their totals out in tests and must move together.
///
/// Nothing here is a new price: each tool reuses a rate the operator already
/// sets on `/pricing`, read at the book's quality tier.
library;

import '../../projects/domain/credit_rates.dart';
import 'assist_models.dart';

/// Words a drafted chapter page holds, for pricing a chapter draft by page.
const studioDraftWordsPerPage = 350;

/// Characters a published page holds, for pricing chapter feedback by page.
const studioFeedbackCharsPerPage = 1900;

/// The default length of a chapter draft when the author names none.
const studioDefaultDraftWords = 1500;

/// Pages a chapter draft is priced at: `ceil(words / 350)`, 1 to 15.
int studioDraftPages(int? targetWords) {
  final words = targetWords ?? studioDefaultDraftWords;
  return ((words / studioDraftWordsPerPage).ceil()).clamp(1, 15);
}

/// Pages chapter feedback is priced at: `ceil(chars / 1900)`, at least 1.
int studioFeedbackPages(int chapterChars) {
  return (chapterChars / studioFeedbackCharsPerPage).ceil().clamp(1, 1 << 20);
}

/// Credits a background tool costs at [qualityPreset].
int estimateStudioAssistCredits({
  required LongAssistKind kind,
  required String qualityPreset,
  required Map<String, dynamic> creditCosts,
  int? targetWords,
  int chapterChars = 0,
}) {
  switch (kind) {
    case LongAssistKind.illustrate:
      return tierCreditRate(creditCosts, 'imageGeneration', qualityPreset, {
        'fast': 70,
        'balanced': 70,
        'premium': 130,
        'ultra': 130,
      });
    case LongAssistKind.draftChapter:
      return studioDraftPages(targetWords) *
          tierCreditRate(
            creditCosts,
            'pageRegenerationPerPage',
            qualityPreset,
            {'fast': 40, 'balanced': 80, 'premium': 220, 'ultra': 280},
          );
    case LongAssistKind.chapterFeedback:
      return flatCreditRate(creditCosts, 'bookTextEditBase', 25) +
          studioFeedbackPages(chapterChars) *
              tierCreditRate(
                creditCosts,
                'bookTextEditPerPage',
                qualityPreset,
                {'fast': 5, 'balanced': 10, 'premium': 28, 'ultra': 36},
              );
    case LongAssistKind.consistency:
      return flatCreditRate(creditCosts, 'premiumReview', 200);
    case LongAssistKind.outline:
      return tierCreditRate(creditCosts, 'planGeneration', qualityPreset, {
        'fast': 20,
        'balanced': 40,
        'premium': 80,
        'ultra': 120,
      });
  }
}

/// Credits an AI-drawn cover costs (a flat rate, whatever the tier).
int estimateStudioCoverCredits(Map<String, dynamic> creditCosts) {
  return flatCreditRate(creditCosts, 'coverRegeneration', 120);
}
