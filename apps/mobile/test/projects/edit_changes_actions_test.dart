import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_changes_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';

const _target = (projectId: 'project-1', operationId: 'operation-1');

MobileEditChanges _changes() => const MobileEditChanges(
  operationId: 'operation-1',
  kind: 'page_rewrite',
  status: 'applied',
  request: 'Make page 3 warmer.',
  creditsCharged: 80,
  addedWords: 4,
  removedWords: 3,
  pages: [
    MobileEditPageChange(
      pageIndex: 3,
      titleBefore: 'The Lamp',
      titleAfter: 'The Lamp',
      titleChanged: false,
      addedWords: 2,
      removedWords: 1,
      blocks: [
        MobileEditDiffBlock(
          type: MobileEditDiffBlockType.changed,
          runs: [
            MobileEditDiffRun(
              type: MobileEditDiffRunType.equal,
              text: 'She lit ',
            ),
            MobileEditDiffRun(type: MobileEditDiffRunType.delete, text: 'the '),
            MobileEditDiffRun(
              type: MobileEditDiffRunType.insert,
              text: 'her old ',
            ),
            MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: 'lamp.'),
          ],
        ),
      ],
    ),
    MobileEditPageChange(
      pageIndex: 9,
      titleBefore: 'Home',
      titleAfter: 'Home',
      titleChanged: false,
      addedWords: 2,
      removedWords: 2,
      blocks: [
        MobileEditDiffBlock(
          type: MobileEditDiffBlockType.changed,
          runs: [
            MobileEditDiffRun(
              type: MobileEditDiffRunType.delete,
              text: 'cold ',
            ),
            MobileEditDiffRun(
              type: MobileEditDiffRunType.insert,
              text: 'warm ',
            ),
            MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: 'door.'),
          ],
        ),
      ],
    ),
  ],
);

MobileBookEditOperation _operation({
  bool canUndo = false,
  bool canRedo = false,
}) => MobileBookEditOperation(
  id: 'operation-1',
  projectId: 'project-1',
  kind: 'page_rewrite',
  status: 'applied',
  affectedPageIndexes: const [3, 9],
  creditsCharged: 80,
  currentAction: 'Pages rewritten.',
  createdAt: DateTime.utc(2026, 6, 15),
  canUndo: canUndo,
  canRedo: canRedo,
  changesAvailable: true,
);

Widget _app({
  required MobileBookEditOperation operation,
  ValueChanged<Object?>? onPopped,
}) {
  return ProviderScope(
    overrides: [
      appConfigProvider.overrideWithValue(
        AppConfig(
          environment: AppEnvironment.local,
          apiBaseUrl: Uri.parse('http://localhost:4001'),
          privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
          termsOfServiceUrl: Uri.parse('https://example.com/terms'),
          accountDeletionUrl: Uri.parse('https://example.com/delete'),
          supportEmail: 'support@example.com',
        ),
      ),
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      editChangesProvider(_target).overrideWith((ref) async => _changes()),
      projectChatProvider('project-1').overrideWith(
        (ref) async =>
            MobileProjectChat(messages: const [], operations: [operation]),
      ),
    ],
    child: MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () async {
              final result = await Navigator.of(context)
                  .push<EditChangesAction>(
                    MaterialPageRoute(
                      builder: (_) => const EditChangesScreen(
                        projectId: 'project-1',
                        operationId: 'operation-1',
                      ),
                    ),
                  );
              onPopped?.call(result);
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('offers Undo when the chat says the edit can be undone', (
    tester,
  ) async {
    Object? popped;
    await tester.pumpWidget(
      _app(operation: _operation(canUndo: true), onPopped: (v) => popped = v),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('changes-revert')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('changes-revert')));
    await tester.pumpAndSettle();
    expect(popped, EditChangesAction.undo);
  });

  testWidgets('offers Redo for an undone edit, and nothing for a settled one', (
    tester,
  ) async {
    await tester.pumpWidget(_app(operation: _operation(canRedo: true)));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Redo'), findsOneWidget);
    expect(find.text('Undo'), findsNothing);
  });

  testWidgets('no revert bar when neither is valid', (tester) async {
    await tester.pumpWidget(_app(operation: _operation()));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('changes-revert')), findsNothing);
  });

  testWidgets('the layout toggle switches to before and after panes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_app(operation: _operation()));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Before'), findsNothing);
    await tester.tap(find.text('Before & after'));
    await tester.pumpAndSettle();
    expect(find.text('Before'), findsNWidgets(2));
    expect(find.text('After'), findsNWidgets(2));
  });

  testWidgets('several pages get a jump strip that scrolls to a page', (
    tester,
  ) async {
    await tester.pumpWidget(_app(operation: _operation()));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Jump to'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Jump to page 9'));
    await tester.pumpAndSettle();
    expect(find.text('Page 9'), findsOneWidget);
  });
}
