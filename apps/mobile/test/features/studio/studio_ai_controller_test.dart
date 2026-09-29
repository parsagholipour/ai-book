import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/presentation/studio_ai_controller.dart';

import '../../support/fake_studio_repository.dart';

int _polls(FakeStudioRepository repo) =>
    repo.calls.where((call) => call.startsWith('getAssist:')).length;

void main() {
  testWidgets('polls while something is working, and stops when nothing is', (
    tester,
  ) async {
    final repo = FakeStudioRepository();
    final settled = <ManuscriptAssist>[];
    final controller = StudioAiController(projectId: 'p1', repository: repo)
      ..onSettled = settled.add;
    addTearDown(controller.dispose);

    final assist = await repo.startAssist(
      'p1',
      const LongAssistRequest(
        kind: LongAssistKind.chapterFeedback,
        requestId: 'r1',
        chapterId: 'c1',
      ),
    );
    controller.track(assist);
    expect(controller.hasWorking, isTrue);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(_polls(repo), 1);

    repo.completeAssist(assist.id, const AssistNotesResult(notes: []));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(_polls(repo), 2);
    expect(settled.single.status, ManuscriptAssistStatus.ready);
    expect(controller.hasWorking, isFalse);
    expect(controller.attentionCount, 1);

    // Nothing working: no more requests, however long the screen stays.
    await tester.pump(const Duration(seconds: 30));
    expect(_polls(repo), 2);
  });

  testWidgets('a hidden screen does not poll until it is back', (tester) async {
    final repo = FakeStudioRepository();
    final controller = StudioAiController(projectId: 'p1', repository: repo);
    final assist = await repo.startAssist(
      'p1',
      const LongAssistRequest(
        kind: LongAssistKind.illustrate,
        requestId: 'r1',
        prompt: 'A lamp',
      ),
    );
    controller
      ..track(assist)
      ..setVisible(false);
    await tester.pump(const Duration(seconds: 10));
    expect(_polls(repo), 0);

    controller.setVisible(true);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(_polls(repo), 1);
    // Still working: the next poll is armed until the screen goes.
    controller.dispose();
  });

  testWidgets('many pictures at once are read with one list per poll', (
    tester,
  ) async {
    final repo = FakeStudioRepository();
    final controller = StudioAiController(projectId: 'p1', repository: repo);
    for (var i = 0; i < 5; i++) {
      controller.track(
        await repo.startAssist(
          'p1',
          LongAssistRequest(
            kind: LongAssistKind.illustrate,
            requestId: 'r$i',
            prompt: 'Page $i',
          ),
        ),
      );
    }
    repo.calls.clear();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(repo.calls, ['listOpenAssists']);

    // One failed: it left the open list, so it is read on its own.
    repo.failAssist(repo.assists.first.id, 'No picture.');
    repo.calls.clear();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(repo.calls, [
      'listOpenAssists',
      'getAssist:${repo.assists.first.id}',
    ]);
    expect(
      controller.assist(repo.assists.first.id)!.status,
      ManuscriptAssistStatus.failed,
    );
    controller.dispose();
  });
}
