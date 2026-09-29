import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_diff_view.dart';

String _joined(List<MobileEditDiffRun> runs, MobileEditDiffRunType type) =>
    runs.where((run) => run.type == type).map((run) => run.text).join('|');

void main() {
  group('diffWords', () {
    test('marks only the words that changed', () {
      final runs = diffWords('a heavy night sky.', 'a heavy day sky.');
      expect(_joined(runs, MobileEditDiffRunType.delete), 'night ');
      expect(_joined(runs, MobileEditDiffRunType.insert), 'day ');
      expect(runs.map((run) => run.text).join(), contains('a heavy '));
    });

    test('an insertion has nothing deleted and a removal nothing inserted', () {
      final added = diffWords('one two', 'one two three');
      expect(_joined(added, MobileEditDiffRunType.delete), isEmpty);
      expect(_joined(added, MobileEditDiffRunType.insert), 'three');
      final removed = diffWords('one two three', 'one two');
      expect(_joined(removed, MobileEditDiffRunType.insert), isEmpty);
      expect(_joined(removed, MobileEditDiffRunType.delete), 'three');
    });

    test('identical text is one equal run', () {
      final runs = diffWords('same words', 'same words');
      expect(runs.single.type, MobileEditDiffRunType.equal);
    });

    test('rebuilding either side from the runs gives the original', () {
      const before = 'Every evening Mara climbed the stairs, slowly.';
      const after = 'Each evening Mara climbed the old stairs, slowly.';
      final runs = diffWords(before, after);
      String side(bool keepDelete) => runs
          .where(
            (run) =>
                run.type == MobileEditDiffRunType.equal ||
                run.type ==
                    (keepDelete
                        ? MobileEditDiffRunType.delete
                        : MobileEditDiffRunType.insert),
          )
          .map((run) => run.text)
          .join();
      expect(side(true).trim(), before);
      expect(side(false).trim(), after);
    });
  });

  testWidgets('before & after layout shows the paragraph twice', (
    tester,
  ) async {
    const changed = MobileEditDiffBlock(
      type: MobileEditDiffBlockType.changed,
      runs: [
        MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: 'She lit '),
        MobileEditDiffRun(type: MobileEditDiffRunType.delete, text: 'the '),
        MobileEditDiffRun(type: MobileEditDiffRunType.insert, text: 'her '),
        MobileEditDiffRun(type: MobileEditDiffRunType.equal, text: 'lamp.'),
      ],
    );
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: EditDiffBlockList(
            blocks: [changed],
            layout: EditDiffLayout.beforeAfter,
          ),
        ),
      ),
    );

    expect(find.text('Before'), findsOneWidget);
    expect(find.text('After'), findsOneWidget);
    expect(find.text('She lit the lamp.'), findsOneWidget);
    expect(find.text('She lit her lamp.'), findsOneWidget);
  });
}
