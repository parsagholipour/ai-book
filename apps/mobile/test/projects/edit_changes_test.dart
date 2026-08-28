import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_changes_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/ui/zoomable_image_viewer.dart';

const _target = (projectId: 'project-1', operationId: 'operation-1');

MobileEditDiffBlock _unchanged(String text) => MobileEditDiffBlock(
  type: MobileEditDiffBlockType.unchanged,
  runs: [MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: text)],
);

MobileEditChanges _changes({
  List<MobileEditDiffBlock>? blocks,
  bool undone = false,
}) {
  return MobileEditChanges(
    operationId: 'operation-1',
    kind: 'local_patch',
    status: 'applied',
    request: 'On page 1, replace "night" with "day".',
    creditsCharged: 35,
    undone: undone,
    addedWords: 1,
    removedWords: 1,
    pages: [
      MobileEditPageChange(
        pageIndex: 1,
        titleBefore: 'Night Falls',
        titleAfter: 'Day Breaks',
        titleChanged: true,
        addedWords: 1,
        removedWords: 1,
        blocks:
            blocks ??
            const [
              MobileEditDiffBlock(
                type: MobileEditDiffBlockType.changed,
                runs: [
                  MobileEditDiffRun(
                    type: MobileEditDiffRunType.equal,
                    text: 'The city slept under a heavy ',
                  ),
                  MobileEditDiffRun(
                    type: MobileEditDiffRunType.delete,
                    text: 'night ',
                  ),
                  MobileEditDiffRun(
                    type: MobileEditDiffRunType.insert,
                    text: 'day ',
                  ),
                  MobileEditDiffRun(
                    type: MobileEditDiffRunType.equal,
                    text: 'sky.',
                  ),
                ],
              ),
            ],
      ),
    ],
  );
}

Widget _app(MobileEditChanges? changes) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(_testConfig),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      editChangesProvider(_target).overrideWith(
        (ref) async =>
            changes ??
            const MobileEditChanges(
              operationId: 'operation-1',
              kind: 'local_patch',
              status: 'applied',
              request: 'Tidy the ending.',
              creditsCharged: 0,
              pages: [],
              addedWords: 0,
              removedWords: 0,
            ),
      ),
    ],
    child: const MaterialApp(
      home: EditChangesScreen(
        projectId: 'project-1',
        operationId: 'operation-1',
      ),
    ),
  );
}

final _testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

void main() {
  testWidgets('shows what the edit asked for and what it moved', (
    tester,
  ) async {
    await tester.pumpWidget(_app(_changes()));
    await tester.pumpAndSettle();

    expect(find.text('On page 1, replace "night" with "day".'), findsOneWidget);
    expect(find.text('1 page changed'), findsOneWidget);
    expect(find.text('Page 1'), findsOneWidget);
    // The title change reads as a replacement, not two unrelated lines.
    expect(find.text('Night Falls'), findsOneWidget);
    expect(find.text('Day Breaks'), findsOneWidget);
    expect(find.text('+1'), findsWidgets);
    expect(find.text('−1'), findsWidgets);
  });

  testWidgets(
    'marks the words that moved rather than reprinting the paragraph',
    (tester) async {
      await tester.pumpWidget(_app(_changes()));
      await tester.pumpAndSettle();

      final paragraph = tester.widget<SelectableText>(
        find.byType(SelectableText).first,
      );
      final spans = (paragraph.textSpan!.children ?? []).cast<TextSpan>();

      expect(spans.map((span) => span.text), [
        'The city slept under a heavy ',
        'night ',
        'day ',
        'sky.',
      ]);
      expect(spans[1].style?.decoration, TextDecoration.lineThrough);
      expect(spans[2].style?.decoration, isNot(TextDecoration.lineThrough));
      expect(spans[1].style?.color, isNot(spans[2].style?.color));
    },
  );

  testWidgets('folds away long stretches the edit never touched', (
    tester,
  ) async {
    // A one-word change inside a long page must not be buried in text that did
    // not move — but the context has to stay reachable.
    await tester.pumpWidget(
      _app(
        _changes(
          blocks: [
            _unchanged('Opening paragraph that did not move.'),
            _unchanged('Second paragraph that did not move.'),
            _unchanged('Third paragraph that did not move.'),
            const MobileEditDiffBlock(
              type: MobileEditDiffBlockType.added,
              runs: [
                MobileEditDiffRun(
                  type: MobileEditDiffRunType.insert,
                  text: 'A new closing line.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('3 unchanged paragraphs'), findsOneWidget);
    expect(find.text('Opening paragraph that did not move.'), findsNothing);
    expect(find.text('A new closing line.'), findsOneWidget);

    await tester.tap(find.text('3 unchanged paragraphs'));
    await tester.pumpAndSettle();

    expect(find.text('Opening paragraph that did not move.'), findsOneWidget);
    expect(find.text('Hide 3 unchanged paragraphs'), findsOneWidget);
  });

  testWidgets('keeps a lone untouched paragraph as context', (tester) async {
    await tester.pumpWidget(
      _app(
        _changes(
          blocks: [
            _unchanged('The paragraph just before the change.'),
            const MobileEditDiffBlock(
              type: MobileEditDiffBlockType.added,
              runs: [
                MobileEditDiffRun(
                  type: MobileEditDiffRunType.insert,
                  text: 'A new closing line.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('The paragraph just before the change.'), findsOneWidget);
    expect(find.textContaining('unchanged paragraphs'), findsNothing);
  });

  testWidgets('says so plainly when an edit changed nothing', (tester) async {
    await tester.pumpWidget(_app(null));
    await tester.pumpAndSettle();

    expect(find.text('Nothing was changed'), findsOneWidget);
  });

  MobileEditChanges structural({
    required String request,
    required List<MobileEditPageChange> pages,
  }) {
    return MobileEditChanges(
      operationId: 'operation-1',
      kind: 'restructure_pages',
      status: 'applied',
      request: request,
      creditsCharged: 0,
      pages: pages,
      addedWords: pages.fold(0, (total, page) => total + page.addedWords),
      removedWords: pages.fold(0, (total, page) => total + page.removedWords),
    );
  }

  MobileEditPageChange structuralPage({
    required MobileEditPageStructuralChange change,
    required int pageIndex,
    String title = 'The long way round',
    String text = '',
    int? pageIndexBefore,
  }) {
    final added = change == MobileEditPageStructuralChange.added;
    final removed = change == MobileEditPageStructuralChange.removed;
    final words = text.trim().isEmpty ? 0 : text.trim().split(' ').length;
    return MobileEditPageChange(
      pageIndex: pageIndex,
      titleBefore: title,
      titleAfter: title,
      titleChanged: false,
      structuralChange: change,
      pageIndexBefore: pageIndexBefore,
      addedWords: added ? words : 0,
      removedWords: removed ? words : 0,
      blocks: text.isEmpty
          ? const []
          : [
              MobileEditDiffBlock(
                type: added
                    ? MobileEditDiffBlockType.added
                    : MobileEditDiffBlockType.removed,
                runs: [
                  MobileEditDiffRun(
                    type: added
                        ? MobileEditDiffRunType.insert
                        : MobileEditDiffRunType.delete,
                    text: text,
                  ),
                ],
              ),
            ],
    );
  }

  // The whole point of an insert is the page it added, and this screen used to
  // answer "+240 −0" and nothing else: a structural edit writes no snapshots, so
  // it listed no pages at all. The text now comes off the stamp — the `Page` rows
  // drafting wrote for an insert, the removed pages the stamp carries whole.
  testWidgets('shows the text an inserted page was written with', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        structural(
          request: 'Add a page after page 10.',
          pages: [
            structuralPage(
              change: MobileEditPageStructuralChange.added,
              pageIndex: 11,
              text: 'The turtle waited by the gate until dawn.',
            ),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Nothing was changed'), findsNothing);
    expect(find.text('1 page added'), findsOneWidget);
    expect(find.text('Page 11'), findsOneWidget);
    expect(find.text('Added to the book'), findsOneWidget);
    expect(
      find.text('The turtle waited by the gate until dawn.'),
      findsOneWidget,
    );
    // An added page is a page the reader can turn to.
    expect(find.text('Open'), findsOneWidget);
  });

  testWidgets(
    'shows the text a deleted page took with it, and offers no Open',
    (tester) async {
      await tester.pumpWidget(
        _app(
          structural(
            request: 'Delete page 2.',
            pages: [
              structuralPage(
                change: MobileEditPageStructuralChange.removed,
                pageIndex: 2,
                text: 'The turtle waited by the gate.',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('1 page removed'), findsOneWidget);
      expect(find.text('Removed from the book'), findsOneWidget);
      expect(find.text('The turtle waited by the gate.'), findsOneWidget);
      // Page 2 is somebody else's page now, so there is nothing to open at it.
      expect(find.text('Open'), findsNothing);
    },
  );

  testWidgets('says where a moved page came from rather than showing a diff', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        structural(
          request: 'Move page 4 after page 7.',
          pages: [
            structuralPage(
              change: MobileEditPageStructuralChange.moved,
              pageIndex: 7,
              pageIndexBefore: 4,
            ),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('1 page moved'), findsOneWidget);
    expect(find.text('Moved here from page 4'), findsOneWidget);
    // A move gains and loses nothing, so the counts stay off the card rather
    // than reading "+0 −0" beside an edit that did move pages.
    expect(find.text('+0'), findsNothing);
    expect(find.text('−0'), findsNothing);
  });

  // An insert the reader undid has no `Page` rows left to read, so the list is
  // empty again — and "Nothing was changed" is still the one thing this screen
  // must not say about an edit that added pages.
  testWidgets('names a structural edit whose pages it can no longer list', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(structural(request: 'Add 3 pages after page 10.', pages: const [])),
    );
    await tester.pumpAndSettle();

    expect(find.text('Nothing was changed'), findsNothing);
    expect(find.text('The book’s pages changed'), findsOneWidget);
    expect(find.text('Add 3 pages after page 10.'), findsOneWidget);
    expect(find.text('0 pages changed'), findsNothing);
  });

  test('reads an illustration replacement from the server payload', () {
    final page = MobileEditPageChange.fromJson({
      'pageIndex': 1,
      'titleBefore': 'The garden',
      'titleAfter': 'The garden',
      'titleChanged': false,
      'blocks': <dynamic>[],
      'addedWords': 0,
      'removedWords': 0,
      'illustrationChanged': true,
      'illustrationBefore': '/assets/images/project-1/page-1.jpg',
      'illustrationAfter': '/assets/images/project-1/page-1-new.jpg',
    });

    expect(page.illustrationChanged, isTrue);
    expect(page.illustrationBefore, '/assets/images/project-1/page-1.jpg');
    expect(page.illustrationAfter, '/assets/images/project-1/page-1-new.jpg');
  });

  testWidgets('shows an illustration replacement instead of an empty diff', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'add_image',
          status: 'applied',
          request: 'change the first image to more aggressive',
          creditsCharged: 40,
          pages: [
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'The garden',
              titleAfter: 'The garden',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Nothing was changed'), findsNothing);
    expect(find.text('Illustration replaced'), findsOneWidget);
    expect(
      find.text('The illustration on this page was replaced.'),
      findsOneWidget,
    );
    expect(find.text('Page 1'), findsOneWidget);
    expect(find.textContaining('unchanged'), findsNothing);
  });

  testWidgets('says when an illustration was removed', (tester) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'remove_image',
          status: 'applied',
          request: 'Remove the picture on page 1',
          creditsCharged: 0,
          pages: [
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'The garden',
              titleAfter: 'The garden',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-1.jpg',
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Illustration removed'), findsOneWidget);
    expect(
      find.text('The illustration on this page was removed.'),
      findsOneWidget,
    );
  });

  testWidgets('counts illustrations rather than pages for a bulk remove', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'remove_image',
          status: 'applied',
          request: 'Remove all the pictures',
          creditsCharged: 0,
          pages: [
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'One',
              titleAfter: 'One',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-1.jpg',
            ),
            MobileEditPageChange(
              pageIndex: 2,
              titleBefore: 'Two',
              titleAfter: 'Two',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-2.jpg',
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('2 illustrations removed'), findsOneWidget);
  });

  testWidgets('says a within-page move moved the picture, not replaced it', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'move_image',
          status: 'applied',
          request: 'Put the picture below the text',
          creditsCharged: 0,
          pages: [
            // One page, both sides set — the same shape a replacement has, which
            // is why the summary has to read the kind and not the nullability.
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'One',
              titleAfter: 'One',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-1.jpg',
              illustrationAfter: '/assets/images/project-1/page-1.jpg',
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Illustration moved'), findsOneWidget);
    expect(find.text('Illustration replaced'), findsNothing);
    expect(
      find.text('The illustration moved to a different place on this page.'),
      findsOneWidget,
    );
  });

  testWidgets('says when an illustration was moved onto a page', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'move_image',
          status: 'applied',
          request: 'Move the picture to page 2',
          creditsCharged: 0,
          pages: [
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'One',
              titleAfter: 'One',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-1.jpg',
            ),
            MobileEditPageChange(
              pageIndex: 2,
              titleBefore: 'Two',
              titleAfter: 'Two',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationAfter: '/assets/images/project-1/page-1.jpg',
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Illustration moved'), findsOneWidget);
    // "Removed" would be wrong here: the picture is still in the book, one page
    // further on, and the next section says so.
    expect(
      find.text('The illustration was moved off this page.'),
      findsOneWidget,
    );
    expect(
      find.text('An illustration was moved onto this page.'),
      findsOneWidget,
    );
  });

  testWidgets('opens the shared image viewer from a replaced illustration', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const MobileEditChanges(
          operationId: 'operation-1',
          kind: 'add_image',
          status: 'applied',
          request: 'change the first image to more aggressive',
          creditsCharged: 40,
          pages: [
            MobileEditPageChange(
              pageIndex: 1,
              titleBefore: 'The garden',
              titleAfter: 'The garden',
              titleChanged: false,
              blocks: [],
              addedWords: 0,
              removedWords: 0,
              illustrationChanged: true,
              illustrationBefore: '/assets/images/project-1/page-1.jpg',
              illustrationAfter: '/assets/images/project-1/page-1-new.jpg',
            ),
          ],
          addedWords: 0,
          removedWords: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('view-illustration-Before')));
    await tester.pumpAndSettle();

    expect(find.byType(ZoomableImageViewer), findsOneWidget);
    expect(find.text('1 of 2'), findsOneWidget);
    expect(find.text('Before'), findsWidgets);
  });

  testWidgets('flags an edit that was undone', (tester) async {
    await tester.pumpWidget(_app(_changes(undone: true)));
    await tester.pumpAndSettle();

    expect(find.textContaining('This edit was undone'), findsOneWidget);
  });
}
