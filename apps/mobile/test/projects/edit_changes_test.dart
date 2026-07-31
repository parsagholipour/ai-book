import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_changes_screen.dart';

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

  testWidgets('marks the words that moved rather than reprinting the paragraph', (
    tester,
  ) async {
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
  });

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

  testWidgets('flags an edit that was undone', (tester) async {
    await tester.pumpWidget(_app(_changes(undone: true)));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('This edit was undone'),
      findsOneWidget,
    );
  });
}
