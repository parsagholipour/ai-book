import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/manuscript_settings_sheet.dart';

import '../../support/fake_studio_repository.dart';

// The book's settings send only what the author changed.

Widget _app(FakeStudioRepository studio, List<Manuscript?> results) {
  return ProviderScope(
    overrides: [studioRepositoryProvider.overrideWithValue(studio)],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async => results.add(
                await showManuscriptSettingsSheet(
                  context,
                  projectId: 'p1',
                  manuscript: studio.snapshot(),
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

Future<void> _open(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(390, 1600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final field = find.byKey(ValueKey(key));
  await tester.ensureVisible(field);
  await tester.enterText(field, text);
}

FakeStudioRepository _studio() => FakeStudioRepository(title: 'Moon Boat')
  ..subtitle = 'A bedtime story'
  ..authorName = 'Parsa'
  ..goalWords = 10000;

void main() {
  group('manuscriptSettingsChanges', () {
    final original = _studio().snapshot();

    test('nothing changed is nothing to send', () {
      expect(
        manuscriptSettingsChanges(
          original,
          title: ' Moon Boat ',
          subtitle: 'A bedtime story',
          authorName: 'Parsa',
          dedication: '',
          artStyle: '  ',
          goalWords: 10000,
        ),
        isNull,
      );
    });

    test('a changed field is sent, an emptied one is cleared', () {
      final update = manuscriptSettingsChanges(
        original,
        title: 'Moon Boat',
        subtitle: '',
        authorName: 'P. Ravan',
        dedication: 'For Mum.',
        artStyle: '',
        goalWords: null,
      )!;
      expect(update.toJson(), {
        'authorName': 'P. Ravan',
        'dedication': 'For Mum.',
        'subtitle': null,
        'goalWords': null,
      });
    });
  });

  test('a word goal reads the way people type it', () {
    expect(parseManuscriptGoal(''), isNull);
    expect(parseManuscriptGoal('50,000'), 50000);
    expect(parseManuscriptGoal('80 000'), 80000);
    expect(() => parseManuscriptGoal('0'), throwsFormatException);
    expect(() => parseManuscriptGoal('lots'), throwsFormatException);
  });

  testWidgets('saving sends only the changed fields and resolves the book', (
    tester,
  ) async {
    final studio = _studio();
    final results = <Manuscript?>[];
    await tester.pumpWidget(_app(studio, results));
    await tester.pumpAndSettle();
    await _open(tester);

    await _type(tester, 'settings-author', 'P. Ravan');
    await _type(tester, 'settings-subtitle', '');
    final pick = find.byKey(const ValueKey('settings-goal-50000'));
    await tester.ensureVisible(pick);
    await tester.tap(pick);
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('settings-save')));
    await tester.pumpAndSettle();

    final sent = studio.settingsUpdates.single.toJson();
    expect(sent, {
      'authorName': 'P. Ravan',
      'goalWords': 50000,
      'subtitle': null,
    });
    expect(results.single?.authorName, 'P. Ravan');
    expect(results.single?.subtitle, isNull);
    expect(results.single?.goalWords, 50000);
  });

  testWidgets('an unchanged sheet saves nothing and resolves null', (
    tester,
  ) async {
    final studio = _studio();
    final results = <Manuscript?>[];
    await tester.pumpWidget(_app(studio, results));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('settings-save')));
    await tester.pumpAndSettle();

    expect(studio.settingsUpdates, isEmpty);
    expect(results, [null]);
  });

  testWidgets('a title too short to print is refused in place', (tester) async {
    final studio = _studio();
    await tester.pumpWidget(_app(studio, []));
    await tester.pumpAndSettle();
    await _open(tester);

    await _type(tester, 'settings-title', 'M');
    await tester.tap(find.byKey(const ValueKey('settings-save')));
    await tester.pumpAndSettle();

    expect(
      find.text('Give your book a title of at least two characters.'),
      findsOneWidget,
    );
    expect(studio.settingsUpdates, isEmpty);
  });
}
