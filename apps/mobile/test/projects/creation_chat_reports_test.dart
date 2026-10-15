import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/ai_content_report.dart';
import 'package:tomeza/features/projects/presentation/book_preview_section.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// Google Play's AI-generated content policy wants every surface that shows AI
// output reportable in the app. The creation chat is the first one a reader
// (and a reviewer) meets: its interview replies, the plan card, and the book
// chat it turns into once the book exists all carry Report; the reader's own
// words never do.

/// Records each report instead of sending it.
class _RecordingReports implements AiContentReportsApi {
  final calls = <Invocation>[];

  @override
  dynamic noSuchMethod(Invocation invocation) {
    calls.add(invocation);
    return Future<void>.value();
  }
}

Map<String, dynamic> _message(String id, String role, String content) => {
  'id': id,
  'role': role,
  'content': content,
  'createdAt': DateTime.utc(2026, 10, 12, 9).toIso8601String(),
};

Future<void> _sendReport(WidgetTester tester) async {
  expect(find.byType(ContentReportDialog), findsOneWidget);
  await tester.tap(find.text('Send report'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('an interview reply offers Report and sends it by draft and id', (
    tester,
  ) async {
    final reports = _RecordingReports();
    final creation = ScriptedCreationRepository(
      sessions: [chatSession(draftId: 'draft-r', title: 'Otter book')],
    );
    creation.resumeMessages['draft-r'] = [
      _message('u1', 'user', 'A book about a brave otter'),
      _message('a1', 'assistant', 'Who is the otter afraid of?'),
    ];
    await tester.pumpWidget(
      app(
        creation: creation,
        draftId: 'draft-r',
        overrides: [aiContentReportsApiProvider.overrideWithValue(reports)],
      ),
    );
    await tester.pumpAndSettle();

    // The reader's own message: Copy and Reply, never Report.
    await tester.longPress(bubbleText('A book about a brave otter'));
    await tester.pumpAndSettle();
    expect(find.text('Copy'), findsOneWidget);
    expect(find.text('Report'), findsNothing);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('Who is the otter afraid of?'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Report'));
    await tester.pumpAndSettle();
    expect(find.text('Report this AI reply'), findsOneWidget);
    await _sendReport(tester);

    final call = reports.calls.single;
    expect(call.memberName, #reportCreationReply);
    expect(call.namedArguments[#draftId], 'draft-r');
    expect(call.namedArguments[#messageId], 'a1');
    expect(call.namedArguments[#reason], 'other');
    expect(find.text('Report sent for review.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('the book chat inside the creation chat reports through the '
      'book chat route', (tester) async {
    final reports = _RecordingReports();
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Finished book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    projects.chatMessages.addAll([
      MobileProjectChatMessage(
        id: 'chat-ask',
        projectId: 'project-1',
        role: 'user',
        content: 'Make chapter two funnier',
        metadata: const {},
        createdAt: DateTime.utc(2026, 10, 12, 10),
      ),
      MobileProjectChatMessage(
        id: 'chat-reply',
        projectId: 'project-1',
        parentId: 'chat-ask',
        role: 'assistant',
        content: 'Here is a lighter take on chapter two.',
        metadata: const {},
        createdAt: DateTime.utc(2026, 10, 12, 10, 1),
      ),
    ]);
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: projects,
        draftId: 'draft-done',
        overrides: [aiContentReportsApiProvider.overrideWithValue(reports)],
      ),
    );
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('Make chapter two funnier'));
    await tester.pumpAndSettle();
    expect(find.text('Report'), findsNothing);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('Here is a lighter take on chapter two.'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Report'));
    await tester.pumpAndSettle();
    await _sendReport(tester);

    final call = reports.calls.single;
    expect(call.memberName, #reportChatReply);
    expect(call.namedArguments[#projectId], 'project-1');
    expect(call.namedArguments[#messageId], 'chat-reply');

    await tester.teardownScreen();
  });

  testWidgets('the plan card offers Report plan and sends the plan id', (
    tester,
  ) async {
    final reports = _RecordingReports();
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-plan',
          title: 'Plan chat',
          createdProjectId: 'project-1',
          outputs: [
            creationOutput(
              projectId: 'project-1',
              title: planTitle,
              sequence: 1,
            ),
          ],
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-plan'] = 'Plan transcript';
    final projects = PlanProjectsRepository(project: plannedProject());
    // Wide enough for the report dialog's reason menu in the test font.
    await tester.binding.setSurfaceSize(const Size(720, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: projects,
        draftId: 'draft-plan',
        overrides: [aiContentReportsApiProvider.overrideWithValue(reports)],
      ),
    );
    await tester.pump();
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final report = find.byKey(const ValueKey('plan-report'));
    expect(report, findsOneWidget);
    await tester.ensureVisible(report);
    await tester.tap(report);
    await tester.pump();
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(find.text('Report this AI book plan'), findsOneWidget);
    await tester.tap(find.text('Send report'));
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final call = reports.calls.single;
    expect(call.memberName, #reportPlan);
    expect(call.namedArguments[#projectId], 'project-1');
    expect(call.namedArguments[#planId], 'plan-1');

    await tester.teardownScreen();
  });
}
