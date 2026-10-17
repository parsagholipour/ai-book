import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

void main() {
  test('creation presets resolve explicit fields, then legacy, then true', () {
    final legacyOff = MobileCreationPresets.fromJson(
      _presetJson(imagesEnabled: false),
    );
    final split = MobileCreationPresets.fromJson(
      _presetJson(
        imagesEnabled: false,
        coverEnabled: true,
        illustrationsEnabled: false,
      ),
    );
    final partial = MobileCreationPresets.fromJson(
      _presetJson(imagesEnabled: false, coverEnabled: true),
    );
    final defaulted = MobileCreationPresets.fromJson(_presetJson());

    expect(
      (legacyOff.coverEnabled, legacyOff.illustrationsEnabled),
      (false, false),
    );
    expect((split.coverEnabled, split.illustrationsEnabled), (true, false));
    expect((partial.coverEnabled, partial.illustrationsEnabled), (true, false));
    expect(
      (defaulted.coverEnabled, defaulted.illustrationsEnabled),
      (true, true),
    );

    final encoded = split.toJson();
    expect(encoded['coverEnabled'], isTrue);
    expect(encoded['illustrationsEnabled'], isFalse);
    expect(encoded['imagesEnabled'], isTrue);
  });

  test('project responses prefer exact flags over a stale aggregate', () {
    final project = MobileProjectSummary.fromJson({
      ..._projectJson(),
      'coverEnabled': true,
      'illustrationsEnabled': false,
      // A stale or old aggregate cannot erase an authoritative split.
      'imagesEnabled': false,
    });
    final legacy = MobileProjectSummary.fromJson({
      ..._projectJson(),
      'imagesEnabled': false,
    });

    expect(project.coverEnabled, isTrue);
    expect(project.illustrationsEnabled, isFalse);
    expect(project.imagesEnabled, isTrue);
    expect(legacy.coverEnabled, isFalse);
    expect(legacy.illustrationsEnabled, isFalse);
  });

  test('create requests send exact fields and the compatibility aggregate', () {
    const request = MobileProjectCreateRequest(
      bookType: 'workbook',
      prompt: 'A practical guide',
      lengthPreset: 'short',
      qualityPreset: 'balanced',
      coverEnabled: false,
      illustrationsEnabled: true,
    );

    expect(request.toJson(), containsPair('coverEnabled', false));
    expect(request.toJson(), containsPair('illustrationsEnabled', true));
    expect(request.toJson(), containsPair('imagesEnabled', true));
  });

  test('generated image summaries name a designed cover as a cover', () {
    expect(
      generatedImagesLabel(coverArtSource: 'ai', illustrationsEnabled: true),
      'Cover + illustrations',
    );
    expect(
      generatedImagesLabel(coverArtSource: 'ai', illustrationsEnabled: false),
      'Cover only',
    );
    // Declining AI cover art still leaves the book with a cover, so saying
    // 'Illustrations only' or 'No generated images' would be wrong.
    expect(
      generatedImagesLabel(
        coverArtSource: 'design',
        illustrationsEnabled: true,
      ),
      'Designed cover + illustrations',
    );
    expect(
      generatedImagesLabel(
        coverArtSource: 'design',
        illustrationsEnabled: false,
      ),
      'Designed cover',
    );
    expect(
      generatedImagesLabel(coverArtSource: 'none', illustrationsEnabled: true),
      'Illustrations only',
    );
    expect(
      generatedImagesLabel(coverArtSource: 'none', illustrationsEnabled: false),
      'No generated images',
    );
  });

  test('a project without an explicit source reads it off the legacy flag', () {
    MobileProjectSummary summary(Map<String, dynamic> overrides) =>
        MobileProjectSummary.fromJson({..._projectJson(), ...overrides});

    expect(summary({'coverEnabled': true}).coverArtSource, 'ai');
    // Declining AI cover art buys a designed cover, not a cover-less book.
    expect(summary({'coverEnabled': false}).coverArtSource, 'design');
    expect(
      summary({'coverEnabled': false, 'coverArtSource': 'none'}).coverArtSource,
      'none',
    );
  });

  test('each quality tier is quoted at its own rates', () {
    // The same three totals `apps/api/src/mobile/creditTierPricing.test.ts`
    // asserts for a 12-page illustrated lead magnet: 2 interior illustrations
    // plus a cover, and no export line for anyone. Two implementations of one
    // formula, and no server quote route between them, so both have to spell
    // the numbers out.
    int estimate(String qualityPreset) => estimateProjectCredits(
      bookType: 'lead_magnet',
      qualityPreset: qualityPreset,
      coverEnabled: true,
      illustrationsEnabled: true,
      targetPages: 12,
      creditCosts: const {},
    );

    expect(estimate('fast'), 150 + 12 * 5 + 3 * 70);
    expect(estimate('balanced'), 250 + 12 * 8 + 3 * 70);
    expect(estimate('premium'), 500 + 12 * 30 + 3 * 130 + 200);
    expect(estimate('ultra'), 650 + 12 * 130 + 3 * 130 + 200);

    // "custom" is what the server sends for a book it has no preset for, and
    // it charges such a book the balanced rates.
    expect(estimate('custom'), estimate('balanced'));
  });

  test('a tier reads its own suffixed key out of the live price list', () {
    int estimate(String qualityPreset, Map<String, dynamic> creditCosts) =>
        estimateProjectCredits(
          bookType: 'lead_magnet',
          qualityPreset: qualityPreset,
          coverEnabled: false,
          illustrationsEnabled: false,
          targetPages: 10,
          creditCosts: creditCosts,
        );

    // Mirrors `tierPrice` in packages/core: the unsuffixed key is balanced.
    const costs = {
      'fullBookPerPage': 8,
      'fullBookPerPageFast': 3,
      'fullBookPerPagePremium': 40,
      'fullBookPerPageUltra': 50,
    };
    expect(estimate('balanced', costs) - estimate('balanced', const {}), 0);
    expect(estimate('fast', costs), estimate('fast', const {}) - 10 * (5 - 3));
    expect(
      estimate('premium', costs),
      estimate('premium', const {}) + 10 * (40 - 30),
    );
    expect(
      estimate('ultra', costs),
      estimate('ultra', const {}) + 10 * (50 - 130),
    );
  });

  test('initial planning mirrors all tier prices and live overrides', () {
    int estimate(
      String qualityPreset, [
      Map<String, dynamic> creditCosts = const {},
    ]) => estimatePlanGenerationCredits(
      qualityPreset: qualityPreset,
      creditCosts: creditCosts,
    );

    expect(estimate('fast'), 20);
    expect(estimate('balanced'), 40);
    expect(estimate('premium'), 80);
    expect(estimate('ultra'), 120);
    expect(estimate('custom'), 40);

    const live = {
      'planGenerationFast': 7,
      'planGeneration': 0,
      'planGenerationPremium': 91,
      'planGenerationUltra': 133,
    };
    expect(estimate('fast', live), 7);
    expect(estimate('balanced', live), 0);
    expect(estimate('premium', live), 91);
    expect(estimate('ultra', live), 133);
  });

  test('a plan revision mirrors the same tier ladder and live overrides', () {
    // A flat 40 charged a Quick Draft revision twice the plan it revised.
    int estimate(
      String qualityPreset, [
      Map<String, dynamic> creditCosts = const {},
    ]) => estimatePlanRevisionCredits(
      qualityPreset: qualityPreset,
      creditCosts: creditCosts,
    );

    expect(estimate('fast'), 20);
    expect(estimate('balanced'), 40);
    expect(estimate('premium'), 80);
    expect(estimate('ultra'), 120);
    expect(estimate('custom'), 40);

    const live = {
      'planRevisionFast': 9,
      'planRevision': 41,
      'planRevisionPremium': 77,
      'planRevisionUltra': 101,
    };
    expect(estimate('fast', live), 9);
    expect(estimate('balanced', live), 41);
    expect(estimate('premium', live), 77);
    expect(estimate('ultra', live), 101);
  });

  test('cover adds one image charge independently from illustrations', () {
    int estimate({
      required bool coverEnabled,
      required bool illustrationsEnabled,
    }) => estimateProjectCredits(
      bookType: 'lead_magnet',
      qualityPreset: 'balanced',
      coverEnabled: coverEnabled,
      illustrationsEnabled: illustrationsEnabled,
      targetPages: 12,
      creditCosts: const {},
    );

    final base = estimate(coverEnabled: false, illustrationsEnabled: false);
    final coverOnly = estimate(coverEnabled: true, illustrationsEnabled: false);
    final illustrationsOnly = estimate(
      coverEnabled: false,
      illustrationsEnabled: true,
    );
    final both = estimate(coverEnabled: true, illustrationsEnabled: true);

    expect(coverOnly - base, 70);
    expect(both - illustrationsOnly, 70);
    expect(both, coverOnly + illustrationsOnly - base);
    final customCover = estimateProjectCredits(
      bookType: 'lead_magnet',
      qualityPreset: 'balanced',
      coverEnabled: true,
      illustrationsEnabled: false,
      targetPages: 12,
      creditCosts: const {'imageGeneration': 63},
    );
    final customBase = estimateProjectCredits(
      bookType: 'lead_magnet',
      qualityPreset: 'balanced',
      coverEnabled: false,
      illustrationsEnabled: false,
      targetPages: 12,
      creditCosts: const {'imageGeneration': 63},
    );
    expect(customCover - customBase, 63);
    expect(
      estimateProjectCredits(
        bookType: 'lead_magnet',
        qualityPreset: 'balanced',
        imagesEnabled: true,
        targetPages: 12,
        creditCosts: const {},
      ),
      both,
    );
    expect(
      estimateProjectCredits(
        bookType: 'lead_magnet',
        qualityPreset: 'balanced',
        imagesEnabled: false,
        targetPages: 12,
        creditCosts: const {},
      ),
      base,
    );
    expect(
      estimatedInteriorImageCount(
        bookType: 'lead_magnet',
        illustrationsEnabled: false,
        targetPages: 12,
      ),
      0,
    );
  });

  test('a 5-page lead magnet is quoted for one interior, not two', () {
    expect(
      estimatedInteriorImageCount(
        bookType: 'lead_magnet',
        illustrationsEnabled: true,
        targetPages: 5,
      ),
      1,
    );
  });

  test('a children\'s story is quoted two pictures for every five pages', () {
    // It is written as a KIDS picture book: the server bills two pictures for
    // every five pages, at most 12 (`pictureBookIllustrationCap`), so a longer
    // book never draws fewer. An adult story keeps page 1 + every 8th.
    int count(String? choice, int pages) => estimatedInteriorImageCount(
      bookType: 'short_story',
      bookTypeChoice: choice,
      illustrationsEnabled: true,
      targetPages: pages,
    );
    expect(count('children_story', 12), 5);
    expect(count('children_story', 3), 1);
    expect(count('children_story', 10), 4);
    expect(count('children_story', 13), 5);
    expect(count('children_story', 16), 6);
    expect(count('children_story', 24), 10);
    expect(count('children_story', 30), 12);
    expect(count('short_story', 12), 2);
    // Auto stays custom, ceil(pages / 8), whatever lane the chat resolved.
    expect(
      estimatedInteriorImageCount(
        bookType: 'custom',
        bookTypeChoice: 'auto',
        illustrationsEnabled: true,
        targetPages: 24,
      ),
      3,
    );
  });

  test('auto quotes as custom, not the advisor recommended type', () {
    expect(
      estimatedInteriorImageCount(
        bookType: 'lead_magnet',
        bookTypeChoice: 'auto',
        illustrationsEnabled: true,
        targetPages: 5,
      ),
      estimatedInteriorImageCount(
        bookType: 'custom',
        illustrationsEnabled: true,
        targetPages: 5,
      ),
    );
    // An 8-page lead magnet would bill two interiors; auto is stored as
    // custom, whose cap is one, matching what generation will attempt.
    expect(
      estimatedInteriorImageCount(
        bookType: 'lead_magnet',
        illustrationsEnabled: true,
        targetPages: 8,
      ),
      2,
    );
    expect(
      estimatedInteriorImageCount(
        bookType: 'lead_magnet',
        bookTypeChoice: 'auto',
        illustrationsEnabled: true,
        targetPages: 8,
      ),
      1,
    );
    expect(quotingBookType('lead_magnet', 'auto'), 'custom');
    expect(quotingBookType('lead_magnet', 'lead_magnet'), 'lead_magnet');
  });
}

Map<String, dynamic> _presetJson({
  bool? imagesEnabled,
  bool? coverEnabled,
  bool? illustrationsEnabled,
}) {
  return {
    'bookType': 'lead_magnet',
    'bookTypeChoice': 'auto',
    'lengthPreset': 'short',
    'qualityPreset': 'balanced',
    'imagesEnabled': ?imagesEnabled,
    'coverEnabled': ?coverEnabled,
    'illustrationsEnabled': ?illustrationsEnabled,
  };
}

Map<String, dynamic> _projectJson() {
  Map<String, dynamic> export(String format) => {
    'format': format,
    'available': false,
    'unlocked': false,
    'creditsRequired': 150,
    'downloadUrl': '/download/$format',
    'filename': 'book.$format',
    'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  };
  return {
    'id': 'project-1',
    'title': 'Book',
    'bookType': 'workbook',
    'lengthPreset': 'short',
    'qualityPreset': 'balanced',
    'status': 'draft',
    'statusLabel': 'Draft',
    'progressPercent': 0,
    'currentAction': 'Ready',
    'promptPreview': 'A book',
    'targetPages': 12,
    'pageCount': 0,
    'imageCount': 0,
    'hasPlan': false,
    'exports': {'pdf': export('pdf'), 'epub': export('epub')},
    'createdAt': '2026-08-05T00:00:00.000Z',
    'updatedAt': '2026-08-05T00:00:00.000Z',
  };
}
