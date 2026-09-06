import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/export_repair_watch.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/export_models.dart';
import 'package:tomeza/features/projects/presentation/project_export_actions.dart';

Map<String, dynamic> _export(String format, {bool requiresSubscription = false}) => {
  'format': format,
  'available': true,
  'unlocked': true,
  'requiresSubscription': requiresSubscription,
  'creditsRequired': 0,
  'downloadUrl': '/api/mobile/projects/p/export/$format',
  'filename': 'book.$format',
  'contentType': 'application/octet-stream',
  'revision': 3,
  'byteSize': 10,
  'updatedAt': '2026-09-06T00:00:00.000Z',
};

void main() {
  group('MobileExportSet.fromJson', () {
    test('reads the Word export and its plan gate when the server sends one', () {
      final set = MobileExportSet.fromJson({
        'pdf': _export('pdf'),
        'epub': _export('epub'),
        'docx': _export('docx', requiresSubscription: true),
      });

      expect(set.docx?.format, 'docx');
      expect(set.docx?.requiresSubscription, isTrue);
      expect(set.pdf.requiresSubscription, isFalse);
      expect(set.all.map((export) => export.format), ['pdf', 'epub', 'docx']);
    });

    test('tolerates a server that offers no Word file', () {
      final set = MobileExportSet.fromJson({
        'pdf': _export('pdf'),
        'epub': _export('epub'),
      });

      expect(set.docx, isNull);
      expect(set.all.map((export) => export.format), ['pdf', 'epub']);
    });

    test('reads a missing requiresSubscription as an ordinary format', () {
      final json = _export('pdf')..remove('requiresSubscription');
      expect(MobileExportAvailability.fromJson(json).requiresSubscription, isFalse);
    });
  });

  test('projectExportFormatLabel prefers a shipped Word label and still maps docx without one', () {
    expect(
      projectExportFormatLabel(
        MobileExportAvailability.fromJson({..._export('docx'), 'label': 'Word'}),
      ),
      'Word',
    );
    expect(
      projectExportFormatLabel(MobileExportAvailability.fromJson(_export('docx'))),
      'Word',
    );
  });

  test('exportUniformTypeIdentifier names a viewer type per format', () {
    expect(exportUniformTypeIdentifier('pdf'), 'com.adobe.pdf');
    expect(exportUniformTypeIdentifier('epub'), 'org.idpf.epub-container');
    expect(
      exportUniformTypeIdentifier('docx'),
      'org.openxmlformats.wordprocessingml.document',
    );
    expect(exportUniformTypeIdentifier('odt'), 'public.data');
  });

  test('ExportRepairFormat names, labels and UTIs cover every value', () {
    const expected = {
      ExportRepairFormat.pdf: ('PDF', 'com.adobe.pdf'),
      ExportRepairFormat.epub: ('EPUB', 'org.idpf.epub-container'),
      ExportRepairFormat.docx: (
        'Word',
        'org.openxmlformats.wordprocessingml.document',
      ),
    };
    expect(expected.keys.toSet(), ExportRepairFormat.values.toSet());
    for (final format in ExportRepairFormat.values) {
      expect(ExportRepairFormat.fromFormat(format.name), format);
      expect((format.fallbackLabel, format.uniformTypeIdentifier), expected[format]);
    }
    expect(ExportRepairFormat.fromFormat('odt'), isNull);
  });
}
