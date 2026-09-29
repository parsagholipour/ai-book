import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_edit_screen.dart';
import 'package:tomeza/features/projects/presentation/book_takeover.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/ui/haptics.dart';

import '../support/fake_studio_repository.dart';
import 'book_page_fixtures.dart';

// "Continue in Writing Studio": a finished generated book's Edit Mode offers,
// in its overflow and nowhere else, to hand the book to its owner as their own
// manuscript — once confirmed, free, and straight into the Studio.

class _Books implements ProjectsRepository {
  _Books(this.project);

  final MobileProjectDetail project;

  @override
  Future<MobileEditableBook> getEditableBook(String projectId) async =>
      const MobileEditableBook(
        projectId: 'project-1',
        title: 'The Lighthouse Letter',
        pages: [
          MobileEditableBookPage(
            id: 'p1',
            index: 1,
            title: 'The Lamp',
            markdown: 'Every evening Mara climbed the stairs.',
            revision: 1,
          ),
        ],
      );

  @override
  Future<MobileProjectDetail> getProject(String projectId) async => project;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not used in this test.');
}

Widget _app({
  required FakeStudioRepository studio,
  MobileProjectDetail? project,
}) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const BookEditScreen(projectId: 'project-1'),
      ),
      GoRoute(
        path: '/projects/:id/write',
        builder: (_, state) =>
            Scaffold(body: Text('studio ${state.pathParameters['id']}')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(
        _Books(project ?? bookProject()),
      ),
      studioRepositoryProvider.overrideWithValue(studio),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

Future<void> _openMenuItem(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('book-edit-menu')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('book-edit-continue-in-studio')));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => AppHaptics.enabled = false);
  tearDown(() => AppHaptics.enabled = true);

  test('only a finished generated book may move into the Studio', () {
    expect(canContinueInStudio(bookProject()), isTrue);
    expect(canContinueInStudio(bookProject(status: 'review_required')), isTrue);
    expect(canContinueInStudio(bookProject(status: 'generating')), isFalse);
    expect(canContinueInStudio(bookProject(status: 'editing')), isFalse);
    expect(canContinueInStudio(bookProject(source: 'written')), isFalse);
    expect(canContinueInStudio(bookProject(source: 'imported')), isFalse);
    expect(canContinueInStudio(null), isFalse);
  });

  testWidgets('confirms once, moves the book and opens the Studio', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();

    await _openMenuItem(tester);
    expect(find.text('Continue in the Writing Studio?'), findsOneWidget);
    expect(find.textContaining('It\'s free'), findsOneWidget);
    expect(find.textContaining('can\'t be undone'), findsOneWidget);
    expect(find.textContaining('no longer rewrite the whole book'), findsOne);

    await tester.tap(find.text('Open in Writing Studio'));
    await tester.pumpAndSettle();

    expect(studio.takeovers, ['project-1']);
    expect(find.text('studio project-1'), findsOneWidget);
  });

  testWidgets('"Not now" changes nothing', (tester) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();

    await _openMenuItem(tester);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();

    expect(studio.takeovers, isEmpty);
    expect(find.text('Edit Mode'), findsOneWidget);
  });

  testWidgets('is not offered for an author\'s book or an unfinished one', (
    tester,
  ) async {
    for (final project in [
      bookProject(source: 'written'),
      bookProject(source: 'imported'),
      bookProject(status: 'generating'),
    ]) {
      await tester.pumpWidget(
        _app(studio: FakeStudioRepository(), project: project),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('book-edit-menu')), findsNothing);
    }
  });

  testWidgets('asks for unsaved edits to be saved first', (tester) async {
    final studio = FakeStudioRepository(projectId: 'project-1');
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('text-p1')),
      'Every evening Mara climbed the old stairs.',
    );
    await tester.pump();

    await _openMenuItem(tester);

    expect(find.text('Continue in the Writing Studio?'), findsNothing);
    expect(find.textContaining('Save or discard your changes'), findsOne);
    expect(studio.takeovers, isEmpty);
  });

  testWidgets('shows paced progress while the book moves', (tester) async {
    final studio = FakeStudioRepository(projectId: 'project-1')
      ..takeoverGate = Completer<void>();
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();

    await _openMenuItem(tester);
    await tester.tap(find.text('Open in Writing Studio'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(BookTakeoverProgress), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    studio.takeoverGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('studio project-1'), findsOneWidget);
  });

  testWidgets('says why the server refused, and stays in Edit Mode', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'project-1')
      ..takeoverError = const ApiException(
        code: 'PROJECT_BUSY',
        message: 'Your book is being narrated. Try again once it is ready.',
        statusCode: 409,
      );
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();

    await _openMenuItem(tester);
    await tester.tap(find.text('Open in Writing Studio'));
    await tester.pumpAndSettle();

    expect(find.textContaining('being narrated'), findsOneWidget);
    expect(find.text('Edit Mode'), findsOneWidget);
    expect(find.text('studio project-1'), findsNothing);
  });

  testWidgets('retries once when another change landed at the same moment', (
    tester,
  ) async {
    final studio = FakeStudioRepository(projectId: 'project-1')
      ..takeoverError = const ApiException(
        code: 'TAKEOVER_RETRY',
        message: 'Another change landed. Try again.',
        statusCode: 409,
      );
    await tester.pumpWidget(_app(studio: studio));
    await tester.pumpAndSettle();

    await _openMenuItem(tester);
    await tester.tap(find.text('Open in Writing Studio'));
    await tester.pumpAndSettle();

    expect(studio.takeovers, ['project-1', 'project-1']);
    expect(find.text('studio project-1'), findsOneWidget);
  });
}
