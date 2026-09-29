import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import '../support/fake_studio_repository.dart';
import 'book_page_fixtures.dart';

// The generated road's last fork, said quietly: under Approve, a text link
// that keeps the plan's outline and hands the writing to the author.

MobilePlan _draftPlan() => MobilePlan(
  id: 'plan-1',
  projectId: 'project-1',
  version: 1,
  status: 'draft',
  title: 'The Lighthouse Letter',
  premise: 'A keeper decides whether to answer a letter from tomorrow.',
  audience: 'Adults.',
  questions: const [],
  chapters: const [
    MobilePlanChapter(
      index: 1,
      title: 'The bottle',
      summary: 'She finds it.',
      targetPages: 8,
    ),
  ],
  createdAt: DateTime.utc(2026, 9, 1),
  updatedAt: DateTime.utc(2026, 9, 1),
);

Future<void> _pump(
  WidgetTester tester, {
  required FakeStudioRepository studio,
  List<String>? visited,
  String source = 'generated',
  String? busyAction,
}) async {
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    bookPageApp(
      visited: visited ?? [],
      project: bookProject(
        status: 'plan_ready',
        plan: _draftPlan(),
        source: source,
      ),
      status: bookStatus(status: 'plan_ready', completed: 0),
      busyAction: busyAction,
      overrides: [studioRepositoryProvider.overrideWithValue(studio)],
    ),
  );
  if (busyAction == null) {
    await tester.pumpAndSettle();
  } else {
    // A busy Approve spins for as long as it is busy.
    await tester.pump(const Duration(milliseconds: 300));
  }
}

final _link = find.byKey(const ValueKey('plan-write-it-myself'));

void main() {
  testWidgets('a quiet link under Approve turns the plan into your outline', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    final visited = <String>[];
    await _pump(tester, studio: studio, visited: visited);

    expect(find.text('Approve and start writing'), findsOneWidget);
    expect(find.text('I\'ll write it myself'), findsOneWidget);
    // A link, not a second button competing with Approve.
    expect(
      find.descendant(of: _link, matching: find.byType(TextButton)),
      findsOneWidget,
    );
    final approve = tester.getRect(find.text('Approve and start writing'));
    expect(tester.getRect(_link).top, greaterThan(approve.bottom));

    await tester.tap(_link);
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Keep this outline and write the book yourself in the Writing '
        'Studio. The AI won\'t write it — you can still use AI tools while '
        'you write.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Write it myself'));
    await tester.pumpAndSettle();

    expect(studio.conversions, ['project-1']);
    expect(visited, ['/projects/project-1/write']);
  });

  testWidgets('cancelling converts nothing', (tester) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    final visited = <String>[];
    await _pump(tester, studio: studio, visited: visited);

    await tester.tap(_link);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(studio.calls, isNot(contains('convertPlanToManuscript')));
    expect(visited, isEmpty);
  });

  testWidgets('a plan the server will not convert says why and stays put', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'project-1')
      ..convertError = const ApiException(
        code: 'PLAN_NOT_CONVERTIBLE',
        message: 'This plan was already approved, so the AI is writing it.',
        statusCode: 409,
      );
    final visited = <String>[];
    await _pump(tester, studio: studio, visited: visited);

    await tester.tap(_link);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Write it myself'));
    await tester.pumpAndSettle();

    expect(
      find.text('This plan was already approved, so the AI is writing it.'),
      findsOneWidget,
    );
    expect(visited, isEmpty);
    // The link is back for another try.
    expect(tester.widget<AppButton>(_link).onPressed, isNotNull);
  });

  testWidgets('no link on an author\'s own book, and none while the plan is '
      'busy', (tester) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    await _pump(tester, studio: studio, source: 'imported');
    expect(find.text('Approve and start writing'), findsOneWidget);
    expect(_link, findsNothing);

    await tester.pumpWidget(const SizedBox());
    await _pump(tester, studio: studio, busyAction: 'approve');
    expect(tester.widget<AppButton>(_link).onPressed, isNull);
  });
}
