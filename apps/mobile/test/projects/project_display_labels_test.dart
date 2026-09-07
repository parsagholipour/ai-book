import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/projects_home_screen.dart';

import '../app/app_test_fixtures.dart';

void main() {
  group('lengthPresetLabel', () {
    test('keeps named length bands', () {
      expect(_summary(lengthPreset: 'short').lengthPresetLabel, 'Short');
      expect(_summary(lengthPreset: 'standard').lengthPresetLabel, 'Standard');
      expect(_summary(lengthPreset: 'expanded').lengthPresetLabel, 'Expanded');
    });

    test('uses the written page count when the stored preset is custom', () {
      expect(
        _summary(
          lengthPreset: 'custom',
          pageCount: 8,
          targetPages: 12,
        ).lengthPresetLabel,
        '8 pages',
      );
    });

    test('falls back to the planned count before any pages exist', () {
      expect(
        _summary(
          lengthPreset: 'custom',
          pageCount: 0,
          targetPages: 8,
        ).lengthPresetLabel,
        '8 pages',
      );
    });

    test('singularizes a one-page custom length', () {
      expect(
        _summary(
          lengthPreset: 'custom',
          pageCount: 1,
          targetPages: 1,
        ).lengthPresetLabel,
        '1 page',
      );
    });

    test('keeps Custom when no page count is known', () {
      expect(
        _summary(
          lengthPreset: 'custom',
          pageCount: 0,
          targetPages: 0,
        ).lengthPresetLabel,
        'Custom',
      );
    });
  });

  group('hasDistinctBookType', () {
    test('is true only for the named product types', () {
      expect(_summary(bookType: 'lead_magnet').hasDistinctBookType, isTrue);
      expect(_summary(bookType: 'workbook').hasDistinctBookType, isTrue);
      expect(_summary(bookType: 'short_story').hasDistinctBookType, isTrue);
      expect(_summary(bookType: 'custom').hasDistinctBookType, isFalse);
      expect(_summary(bookType: 'custom').bookTypeLabel, 'Book');
    });
  });

  test('home-shelf meta omits the generic Book type', () {
    expect(
      projectMeta(_summary(bookType: 'custom', lengthPreset: 'custom', pageCount: 8)),
      isNot(contains('Book')),
    );
    expect(
      projectMeta(_summary(bookType: 'workbook')),
      contains('Workbook'),
    );
  });
}

MobileProjectSummary _summary({
  String bookType = 'workbook',
  String lengthPreset = 'standard',
  int pageCount = 0,
  int targetPages = 28,
}) {
  final base = fakeProject();
  return MobileProjectSummary(
    id: base.id,
    title: base.title,
    bookType: bookType,
    lengthPreset: lengthPreset,
    qualityPreset: base.qualityPreset,
    imagesEnabled: base.imagesEnabled,
    status: base.status,
    statusLabel: base.statusLabel,
    progressPercent: base.progressPercent,
    currentAction: base.currentAction,
    promptPreview: base.promptPreview,
    targetPages: targetPages,
    pageCount: pageCount,
    imageCount: base.imageCount,
    hasPlan: base.hasPlan,
    exports: base.exports,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  );
}
