import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/publish_sheet.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/media/photo_picker.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import '../../support/fake_studio_repository.dart';
import '../../support/studio_cover_test_support.dart';

// Write freely, publish deliberately: the sheet between the working copy and
// the book people read.

class _Harness {
  final visited = <String>[];
  final results = <bool>[];
}

Widget _app(
  FakeStudioRepository studio,
  _Harness harness, {
  List<Override> overrides = const [],
}) {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: Consumer(
            builder: (context, ref, _) {
              // Watched, so the sheet's invalidation shows as a re-fetch.
              ref.watch(manuscriptProvider('p1'));
              return Center(
                child: TextButton(
                  onPressed: () async => harness.results.add(
                    await showPublishSheet(context, projectId: 'p1'),
                  ),
                  child: const Text('Open'),
                ),
              );
            },
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id/write',
        builder: (context, state) {
          harness.visited.add(state.uri.toString());
          return const Scaffold(body: Text('studio'));
        },
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      studioRepositoryProvider.overrideWithValue(studio),
      ...overrides,
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: router,
    ),
  );
}

FakeStudioRepository _studio({bool published = false}) => FakeStudioRepository(
  published: published,
  chapters: [
    FakeStudioChapter(
      id: 'c1',
      title: 'The bottle',
      markdown: 'She found it at dawn, green glass.',
    )..unpublished = true,
    FakeStudioChapter(id: 'c2', title: '', markdown: 'She wrote back.')
      ..unpublished = true,
  ],
);

Future<void> _open(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(390, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

AppButton _publishButton(WidgetTester tester) =>
    tester.widget<AppButton>(find.byKey(const ValueKey('publish-button')));

int _manuscriptFetches(FakeStudioRepository studio) =>
    studio.calls.where((call) => call == 'getManuscript').length;

void main() {
  testWidgets('a first publish says what it will make, then makes it', (
    tester,
  ) async {
    final studio = _studio()
      ..checklistItems = const [
        PublishChecklistItem(
          kind: PublishChecklistKind.untitledChapter,
          chapterId: 'c2',
          message: 'Chapter 2 has no title.',
          blocking: false,
        ),
      ]
      ..publishGate = Completer<void>();
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    await _open(tester);

    expect(find.text('Publish your book'), findsOneWidget);
    expect(find.text('10'), findsOneWidget);
    expect(find.text('words'), findsOneWidget);
    expect(find.text('~6'), findsOneWidget);
    // The cover is one quiet row: designed unless the author says otherwise.
    expect(find.text('Cover'), findsOneWidget);
    expect(find.text('Designed with your title and name'), findsOneWidget);
    expect(find.byKey(const ValueKey('cover-change')), findsOneWidget);
    // Collapsed, it offers no choices yet (and fetches no prices).
    expect(find.text('Generate with AI'), findsNothing);
    expect(find.text('Chapter 2 has no title.'), findsOneWidget);
    expect(_publishButton(tester).onPressed, isNotNull);
    final fetchesBefore = _manuscriptFetches(studio);

    await tester.tap(find.text('Publish book'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // A real wait, not a spinner: the copy says what is happening.
    expect(find.text('Setting your pages…'), findsOneWidget);
    expect(find.text('Publish book'), findsNothing);

    studio.publishGate!.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();

    expect(harness.results, [true]);
    expect(studio.published, isTrue);
    expect(find.text('Publish your book'), findsNothing);
    expect(_manuscriptFetches(studio), greaterThan(fetchesBefore));
  });

  testWidgets('a blocking item keeps Update book shut', (tester) async {
    final studio = _studio(published: true)
      ..checklistItems = const [
        PublishChecklistItem(
          kind: PublishChecklistKind.conflict,
          chapterId: 'c1',
          message: 'The bottle was also changed in the chat.',
          blocking: true,
        ),
      ];
    await tester.pumpWidget(_app(studio, _Harness()));
    await tester.pumpAndSettle();
    await _open(tester);

    expect(find.text('Update your book'), findsOneWidget);
    expect(find.text('A chapter needs your decision'), findsOneWidget);
    expect(
      find.text('The bottle was also changed in the chat.'),
      findsOneWidget,
    );
    // No cover choice on an update: the book already has one, and it is
    // changed from the book's page.
    expect(find.byKey(const ValueKey('publish-cover')), findsNothing);
    expect(_publishButton(tester).label, 'Update book');
    expect(_publishButton(tester).onPressed, isNull);
    expect(studio.calls, isNot(contains('publish')));
  });

  testWidgets('an item about a chapter opens that chapter in the Studio', (
    tester,
  ) async {
    final studio = _studio()
      ..checklistItems = const [
        PublishChecklistItem(
          kind: PublishChecklistKind.untitledChapter,
          chapterId: 'c2',
          message: 'Chapter 2 has no title.',
          blocking: false,
        ),
      ];
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.text('Chapter 2 has no title.'));
    await tester.pumpAndSettle();

    expect(harness.results, [false]);
    expect(harness.visited, ['/projects/p1/write?chapter=c2']);
  });

  testWidgets('a book changed in the chat refreshes and asks for a look', (
    tester,
  ) async {
    final studio = _studio();
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    await _open(tester);
    final fetchesBefore = _manuscriptFetches(studio);

    studio.publishErrorCode = 'BOOK_CHANGED';
    await tester.tap(find.text('Publish book'));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Your book changed in the chat since you opened it. We\'ve refreshed '
        'your chapters — check them and publish again.',
      ),
      findsOneWidget,
    );
    expect(_manuscriptFetches(studio), greaterThan(fetchesBefore));

    await tester.tap(find.text('Check my chapters'));
    await tester.pumpAndSettle();
    expect(harness.results, [false]);
  });

  testWidgets('a busy book is a wait, and the button stays for later', (
    tester,
  ) async {
    final studio = _studio();
    await tester.pumpWidget(_app(studio, _Harness()));
    await tester.pumpAndSettle();
    await _open(tester);

    studio.publishErrorCode = 'PROJECT_BUSY';
    await tester.tap(find.text('Publish book'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Not just yet'), findsOneWidget);
    expect(find.text(ManuscriptPublishBlock.busy.message), findsOneWidget);
    expect(_publishButton(tester).onPressed, isNotNull);
  });

  testWidgets('the cover opens in place, and an upload holds Publish', (
    tester,
  ) async {
    final studio = _studio()..coverGate = Completer<void>();
    final picker = CoverTestPicker(result: coverTestPhoto());
    await tester.pumpWidget(
      _app(studio, _Harness(), overrides: coverTestOverrides(picker: picker)),
    );
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('cover-change')));
    await tester.pumpAndSettle();
    expect(find.text('Designed'), findsOneWidget);
    expect(find.text('Your own picture'), findsOneWidget);
    expect(find.text('Generate with AI'), findsOneWidget);

    await tester.tap(find.text('Your own picture'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose from photos'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(picker.calls.single, (
      source: ImageSource.gallery,
      purpose: PhotoPickerPurpose.bookImage,
    ));
    expect(studio.calls, contains('uploadCover:lighthouse.jpg'));
    expect(find.text('Uploading your picture…'), findsOneWidget);
    // Publishing now would bind the book before its cover arrived.
    expect(_publishButton(tester).onPressed, isNull);

    studio.coverGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('Uploading your picture…'), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('cover-choice-upload')),
        matching: find.byIcon(Icons.radio_button_checked),
      ),
      findsOneWidget,
    );
    expect(_publishButton(tester).onPressed, isNotNull);
  });

  testWidgets('a publish refused for its words names each chapter and opens it', (
    tester,
  ) async {
    const sentence =
        'Tomeza cannot help create content that facilitates severe illegal harm.';
    final studio = _studio()
      ..publishError = const ApiException(
        code: 'CONTENT_RESTRICTED',
        message: sentence,
        statusCode: 422,
        details: {
          'code': 'CONTENT_RESTRICTED',
          'message': sentence,
          'reason': 'critical_illegal_harm',
          'chapters': [
            {'chapterId': 'c1', 'title': 'The bottle'},
            {'chapterId': 'c2', 'title': ''},
          ],
          'fields': <String>[],
        },
      );
    final harness = _Harness();
    await tester.pumpWidget(_app(studio, harness));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.text('Publish book'));
    await tester.pumpAndSettle();

    expect(studio.published, isFalse);
    expect(find.text('This can’t be published'), findsNWidgets(2));
    expect(find.text('In “The bottle”: $sentence'), findsOneWidget);
    expect(find.text('In an untitled chapter: $sentence'), findsOneWidget);
    // Not a failure to retry: the words have to change first.
    expect(find.text('Could not publish'), findsNothing);
    expect(_publishButton(tester).onPressed, isNull);
    expect(find.text('Sort out what is marked above first.'), findsOneWidget);

    final bottle = find.ancestor(
      of: find.text('In “The bottle”: $sentence'),
      matching: find.byType(AppInlineNotice),
    );
    final open = find.descendant(
      of: bottle,
      matching: find.text('Open chapter'),
    );
    await tester.ensureVisible(open);
    await tester.pumpAndSettle();
    await tester.tap(open);
    await tester.pumpAndSettle();

    expect(harness.results, [false]);
    expect(harness.visited, ['/projects/p1/write?chapter=c1']);
  });

  testWidgets('a refusal of the book’s own details says where to change them', (
    tester,
  ) async {
    const sentence =
        'Tomeza cannot create a fake official document intended to pass as '
        'genuine.';
    final studio = _studio(published: true)
      ..publishError = const ApiException(
        code: 'CONTENT_RESTRICTED',
        message: sentence,
        statusCode: 422,
        details: {
          'code': 'CONTENT_RESTRICTED',
          'message': sentence,
          'reason': 'deceptive_official_artifact',
          'chapters': <Object>[],
          'fields': ['title', 'authorName'],
        },
      );
    await tester.pumpWidget(_app(studio, _Harness()));
    await tester.pumpAndSettle();
    await _open(tester);

    await tester.tap(find.text('Update book'));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'In your book’s title and author name: $sentence Change it in Book '
        'settings.',
      ),
      findsOneWidget,
    );
    expect(find.text('Open chapter'), findsNothing);
    expect(_publishButton(tester).onPressed, isNull);
  });

  test('a refusal naming the audiobook is said as the audiobook wait', () {
    expect(
      publishWaitMessage(
        const ApiException(
          code: 'PROJECT_BUSY',
          message: 'An audiobook is being narrated for this book.',
          statusCode: 409,
        ),
      ),
      ManuscriptPublishBlock.audiobook.message,
    );
    expect(
      publishWaitMessage(
        const ApiException(
          code: 'EMPTY_MANUSCRIPT',
          message: 'Nothing to publish.',
          statusCode: 409,
        ),
      ),
      isNull,
    );
  });
}
