import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_history_sheet.dart';
import 'package:tomeza/shared/api/api_client.dart';

MobileBookEditOperation _op(
  String id, {
  required DateTime at,
  String kind = 'page_rewrite',
  String status = 'applied',
  String action = 'Page 3 rewritten.',
  int credits = 80,
  List<int> pages = const [3],
  bool canUndo = false,
  bool canRedo = false,
  bool changes = true,
  String? request,
}) => MobileBookEditOperation(
  id: id,
  projectId: 'project-1',
  kind: kind,
  status: status,
  affectedPageIndexes: pages,
  creditsCharged: credits,
  currentAction: action,
  createdAt: at,
  canUndo: canUndo,
  canRedo: canRedo,
  changesAvailable: changes,
  submittedText: request,
);

Widget _host(
  List<MobileBookEditOperation> operations,
  void Function(EditHistoryChoice?) onChoice,
) {
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
      projectChatProvider('project-1').overrideWith(
        (ref) async =>
            MobileProjectChat(messages: const [], operations: operations),
      ),
    ],
    child: MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () async => onChoice(
                await showEditHistorySheet(context, projectId: 'project-1'),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  final now = DateTime.now();

  testWidgets('groups edits by day, newest first', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      _host([
        _op(
          'old',
          at: now.subtract(const Duration(days: 3)),
          action: 'Illustration moved.',
        ),
        _op('new', at: now, action: 'Page 3 rewritten.'),
        _op(
          'yesterday',
          at: now.subtract(const Duration(days: 1)),
          action: 'Page 5 rewritten.',
        ),
      ], (_) {}),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Edit history'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Yesterday'), findsOneWidget);
    final today = tester.getTopLeft(find.text('Page 3 rewritten.')).dy;
    final yesterday = tester.getTopLeft(find.text('Page 5 rewritten.')).dy;
    expect(today, lessThan(yesterday));

    // The oldest edit is further down, under its own date.
    await tester.scrollUntilVisible(
      find.text('Illustration moved.'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('Illustration moved.'), findsOneWidget);
  });

  testWidgets('offers Undo, Redo and See changes only where they are valid', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      _host([
        _op('latest', at: now, canUndo: true, request: 'Make page 3 warmer'),
        _op(
          'undone',
          at: now.subtract(const Duration(hours: 1)),
          canRedo: true,
          action: 'Page 4 rewritten.',
        ),
        _op(
          'plain',
          at: now.subtract(const Duration(hours: 2)),
          changes: false,
          action: 'Page 5 rewritten.',
        ),
      ], (_) {}),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Undo'), findsOneWidget);
    expect(find.text('Redo'), findsOneWidget);
    expect(find.text('See changes'), findsNWidgets(2));
    expect(find.text('Undone'), findsOneWidget);
    expect(find.text('“Make page 3 warmer”'), findsOneWidget);
  });

  testWidgets(
    'a failed edit says it did not finish and that credits came back',
    (tester) async {
      await tester.pumpWidget(
        _host([
          MobileBookEditOperation(
            id: 'failed',
            projectId: 'project-1',
            kind: 'page_rewrite',
            status: 'failed',
            affectedPageIndexes: const [3],
            creditsCharged: 80,
            currentAction: 'Edit failed.',
            createdAt: now,
            creditsRefunded: true,
          ),
        ], (_) {}),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Did not finish'), findsOneWidget);
      expect(find.text('Undo'), findsNothing);
      expect(find.text('See changes'), findsNothing);
    },
  );

  testWidgets('tapping Undo answers with the choice and closes', (
    tester,
  ) async {
    EditHistoryChoice? choice;
    await tester.pumpWidget(
      _host([_op('latest', at: now, canUndo: true)], (value) => choice = value),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();

    expect(choice?.kind, EditHistoryChoiceKind.undo);
    expect(choice?.operation?.id, 'latest');
    expect(find.text('Edit history'), findsNothing);
  });

  testWidgets('an empty history says what to do and offers it', (tester) async {
    EditHistoryChoice? choice;
    await tester.pumpWidget(_host(const [], (value) => choice = value));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('No edits yet'), findsOneWidget);
    await tester.tap(find.text('Ask for a change'));
    await tester.pumpAndSettle();
    expect(choice?.kind, EditHistoryChoiceKind.askForChange);
  });
}
