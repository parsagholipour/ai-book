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
      generatedImagesLabel(coverArtSource: 'design', illustrationsEnabled: true),
      'Designed cover + illustrations',
    );
    expect(
      generatedImagesLabel(coverArtSource: 'design', illustrationsEnabled: false),
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

    expect(coverOnly - base, 45);
    expect(both - illustrationsOnly, 45);
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
