import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/version_history_sheet.dart';

import '../../support/fake_studio_repository.dart';

// A chapter's kept versions: listed newest first, read before restoring.

Widget _app(FakeStudioRepository studio, List<ManuscriptVersion?> results) {
  return ProviderScope(
    overrides: [studioRepositoryProvider.overrideWithValue(studio)],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async => results.add(
                await showVersionHistorySheet(
                  context,
                  projectId: 'p1',
                  chapterId: 'c1',
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
}

ManuscriptVersion _version(
  String id,
  ManuscriptVersionReason reason,
  DateTime at,
  String markdown,
) => ManuscriptVersion(
  id: id,
  reason: reason,
  title: 'The bottle',
  wordCount: markdown.split(' ').length,
  createdAt: at,
  markdown: markdown,
);

Future<void> _open(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(390, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('no versions yet explains that they are kept automatically', (
    tester,
  ) async {
    await tester.pumpWidget(_app(FakeStudioRepository(), []));
    await tester.pumpAndSettle();
    await _open(tester);

    expect(find.text('No earlier versions yet'), findsOneWidget);
    expect(find.textContaining('kept automatically'), findsOneWidget);
  });

  testWidgets('a version is read first, then restored whole', (tester) async {
    final studio = FakeStudioRepository();
    final now = DateTime.now();
    studio.chapters.first.versions.addAll([
      _version(
        'v-old',
        ManuscriptVersionReason.auto,
        now.subtract(const Duration(days: 3)),
        'An older draft.',
      ),
      _version(
        'v-new',
        ManuscriptVersionReason.publish,
        now.subtract(const Duration(minutes: 12)),
        '## The shore\n\nShe found it at **dawn**.\n\n![A green bottle](/assets/images/p1/upload-1.jpg)',
      ),
    ]);
    final results = <ManuscriptVersion?>[];
    await tester.pumpWidget(_app(studio, results));
    await tester.pumpAndSettle();
    await _open(tester);

    // Newest first, whatever order the server listed them in.
    final newest = tester.getTopLeft(
      find.byKey(const ValueKey('version-row-v-new')),
    );
    final oldest = tester.getTopLeft(
      find.byKey(const ValueKey('version-row-v-old')),
    );
    expect(newest.dy, lessThan(oldest.dy));
    expect(find.textContaining('12m ago'), findsOneWidget);
    expect(find.textContaining('Published'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('version-row-v-new')));
    await tester.pumpAndSettle();

    expect(studio.calls, contains('getVersion:v-new'));
    expect(find.text('The shore'), findsOneWidget);
    expect(find.textContaining('[Picture: A green bottle]'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('version-restore')));
    await tester.pumpAndSettle();

    expect(results.single?.id, 'v-new');
    expect(results.single?.markdown, contains('She found it at **dawn**.'));
  });

  testWidgets('back from a preview returns to the list', (tester) async {
    final studio = FakeStudioRepository();
    studio.chapters.first.versions.add(
      _version('v1', ManuscriptVersionReason.auto, DateTime.now(), 'Draft.'),
    );
    final results = <ManuscriptVersion?>[];
    await tester.pumpWidget(_app(studio, results));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('version-row-v1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('All versions'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('version-row-v1')), findsOneWidget);
    expect(results, isEmpty);
  });

  test('the preview names pictures and shows page breaks', () {
    expect(
      versionPreviewMarkdown(
        'One.\n<!-- page -->\n![](/a.jpg)\n![A cat](/b.png)\nTwo.',
      ),
      'One.\n· · ·\n*[Picture]*\n*[Picture: A cat]*\nTwo.',
    );
  });
}
