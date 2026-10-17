import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_credit_budget.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';

const _presets = MobileCreationPresets(
  bookType: 'lead_magnet',
  lengthPreset: 'short',
  qualityPreset: 'balanced',
);

void main() {
  int affordable(
    int credits, {
    int pages = 20,
    MobileCreationPresets presets = _presets,
    Map<String, dynamic> costs = const {},
  }) => affordableCreationPages(
    presets: presets,
    targetPages: pages,
    availableCredits: credits,
    creditCosts: costs,
  );

  test('accounts for planning and the exact affordability boundary', () {
    final presets = _presets.copyWith(
      coverEnabled: false,
      illustrationsEnabled: false,
    );
    // 40 planning + 250 base + 10 * 8 writing. No export line: a written
    // book downloads free.
    expect(affordable(370, presets: presets), 10);
    expect(affordable(369, presets: presets), 9);
    expect(affordable(370, pages: 5, presets: presets), 5);
  });

  test('includes cover and stepped Auto illustration charges', () {
    // 40 planning + 250 base + 64 writing + 70 cover + 70 interior.
    expect(affordable(494), 8);
    expect(affordable(493), 7);
    // Page 9 adds another interior image: 40 + 250 + 72 + 70 + 140.
    expect(affordable(571), 8);
    expect(affordable(572), 9);
    expect(affordable(494, presets: _presets.copyWith(coverEnabled: false)), 8);
    // Cover only: 40 + 250 + 16 * 8 + 70.
    expect(
      affordable(494, presets: _presets.copyWith(illustrationsEnabled: false)),
      16,
    );
  });

  test('never suggests zero as a valid book or borrows credits', () {
    expect(affordable(0), 0);
    // 40 planning + 250 base + 8 writing + 70 cover + 70 interior.
    expect(affordable(437), 0);
    expect(affordable(438), 1);
  });

  test('respects each effort tier including premium review', () {
    for (final entry in {
      'fast': 210,
      'balanced': 354,
      'premium': 1020,
      'ultra': 2010,
    }.entries) {
      final presets = _presets.copyWith(
        qualityPreset: entry.key,
        coverEnabled: false,
        illustrationsEnabled: false,
      );
      expect(affordable(entry.value, presets: presets), 8, reason: entry.key);
      expect(
        affordable(entry.value - 1, presets: presets),
        7,
        reason: entry.key,
      );
    }
  });

  test('uses server-configured prices, including free generation', () {
    final presets = _presets.copyWith(qualityPreset: 'premium');
    const costs = {
      'fullBookBasePremium': 20,
      'fullBookPerPagePremium': 3,
      'planGenerationPremium': 11,
      'imageGenerationPremium': 7,
      'premiumReview': 13,
      // An older price list's unlock price is never part of a book's quote.
      'exportUnlock': 17,
    };
    // 11 planning + 20 base + 8 * 3 + 7 cover + 7 interior + 13 review.
    expect(affordable(91, presets: presets, costs: costs), 8);
    expect(affordable(92, presets: presets, costs: costs), 9);
    expect(
      affordable(
        0,
        pages: 600,
        costs: {
          'fullBookBase': 0,
          'fullBookPerPage': 0,
          'planGeneration': 0,
          'imageGeneration': 0,
          'exportUnlock': 0,
        },
      ),
      600,
    );
  });
}
