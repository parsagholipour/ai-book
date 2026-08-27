import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

Map<String, dynamic> statusJson({Object? pdfPageNumbering}) {
  return {
    'projectId': 'project-1',
    'status': 'complete',
    'statusLabel': 'Complete',
    'progressPercent': 100,
    'currentAction': 'Ready',
    'retryAvailable': false,
    'steps': <Object?>[],
    'pageProgress': {'completed': 1, 'target': 1},
    'imageCount': 0,
    'exports': {'pdf': exportJson('pdf'), 'epub': exportJson('epub')},
    'quality': <String, Object?>{},
    'updatedAt': '2026-08-18T00:00:00.000Z',
    'hasCoverPage': true,
    'pdfPageNumbering': ?pdfPageNumbering,
  };
}

Map<String, dynamic> exportJson(String format) {
  return {
    'format': format,
    'available': format == 'pdf',
    'unlocked': true,
    'creditsRequired': 0,
    'downloadUrl': '/export/$format',
    'filename': 'book.$format',
    'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
    'revision': 8,
    'byteSize': 100,
    'updatedAt': '2026-08-18T00:00:00.000Z',
  };
}

void main() {
  test(
    'parses the stored PDF numbering identity independently of status revision',
    () {
      final status = MobileProjectStatus.fromJson(
        statusJson(
          pdfPageNumbering: {
            'hasCoverPage': true,
            'contentRevision': 7,
            'pdfDigest': 'pdf-digest-old',
          },
        ),
      );

      expect(status.exports.pdf.revision, 8);
      expect(status.pdfPageNumbering?.hasCoverPage, isTrue);
      expect(status.pdfPageNumbering?.contentRevision, 7);
      expect(status.pdfPageNumbering?.pdfDigest, 'pdf-digest-old');
    },
  );

  test('legacy top-level cover flag alone carries no numbering identity', () {
    final status = MobileProjectStatus.fromJson(statusJson());

    expect(status.hasCoverPage, isTrue, reason: 'kept for old callers');
    expect(status.pdfPageNumbering, isNull);
  });

  test('malformed or incomplete numbering identity fails soft', () {
    for (final malformed in <Object?>[
      {'hasCoverPage': true, 'contentRevision': 7},
      {'hasCoverPage': true, 'contentRevision': 7, 'pdfDigest': ''},
      {'hasCoverPage': true, 'contentRevision': -1, 'pdfDigest': 'digest'},
      {'hasCoverPage': 'yes', 'contentRevision': 7, 'pdfDigest': 'digest'},
      'not-an-object',
    ]) {
      final status = MobileProjectStatus.fromJson(
        statusJson(pdfPageNumbering: malformed),
      );
      expect(status.pdfPageNumbering, isNull);
    }
  });

  test('recovery confirmation defaults true and honors a plan retry opt-out', () {
    final legacy = MobileProjectStatus.fromJson({
      ...statusJson(),
      'recoveryQuote': {
        'retryToken': 'legacy-confirmed-token',
        'credits': 40,
      },
    });
    final initialPlan = MobileProjectStatus.fromJson({
      ...statusJson(),
      'recoveryQuote': {
        'retryToken': 'initial-plan-token',
        'credits': 80,
        'requiresConfirmation': false,
      },
    });

    expect(legacy.recoveryQuote?.requiresConfirmation, isTrue);
    expect(initialPlan.recoveryQuote?.requiresConfirmation, isFalse);
    expect(initialPlan.recoveryQuote?.credits, 80);
  });
}
