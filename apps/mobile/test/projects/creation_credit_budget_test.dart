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
    // 40 planning + 350 base + 150 export + 10 * 8 writing.
    expect(affordable(620, presets: presets), 10);
    expect(affordable(619, presets: presets), 9);
    expect(affordable(620, pages: 5, presets: presets), 5);
  });

  test('includes cover and stepped Auto illustration charges', () {
    // 40 planning + 500 base/export + 64 writing + 45 cover + 45 interior.
    expect(affordable(694), 8);
    expect(affordable(693), 7);
    // Page 9 adds another interior image: 40 + 500 + 72 + 45 + 90.
    expect(affordable(746), 8);
    expect(affordable(747), 9);
    expect(affordable(694, presets: _presets.copyWith(coverEnabled: false)), 8);
    expect(
      affordable(694, presets: _presets.copyWith(illustrationsEnabled: false)),
      13,
    );
  });

  test('never suggests zero as a valid book or borrows credits', () {
    expect(affordable(0), 0);
    expect(affordable(637), 0);
    expect(affordable(638), 1);
  });

  test('respects each effort tier including premium review', () {
    for (final entry in {
      'fast': 430,
      'balanced': 604,
      'premium': 1170,
      'ultra': 1688,
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
      'exportUnlock': 17,
    };
    expect(affordable(108, presets: presets, costs: costs), 8);
    expect(affordable(109, presets: presets, costs: costs), 9);
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
