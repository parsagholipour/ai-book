import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The finished-book turn in the creation chat, where the reader of "The Last
// Table" set their author name (2026-10-17): the free reprint's "Done" reply
// ends with the book — updating while the new PDF is made, then Open book.

const _done =
    'Done — the author name is now “Parsa Gholipour”. I’m refreshing the '
    'exports. This one’s free.';

MobileExportSet _exports({required int revision}) => MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
    revision: revision,
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
    revision: revision,
  ),
);

void main() {
  testWidgets('the reply that rebuilt the book shows it updating, then ready', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(400, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
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
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    projects.status = projectStatus(
      status: 'editing',
      progressPercent: 40,
      currentAction: 'Preparing your PDF',
      exports: _exports(revision: 2),
    );
    projects.chatMessages.addAll([
      MobileProjectChatMessage(
        id: 'chat-ask',
        projectId: 'project-1',
        parentId: null,
        role: 'user',
        content: 'Whatever I added in my profile',
        metadata: const {},
        createdAt: DateTime.utc(2026, 10, 17, 17, 34),
      ),
      MobileProjectChatMessage(
        id: 'chat-done',
        projectId: 'project-1',
        parentId: 'chat-ask',
        role: 'assistant',
        content: _done,
        metadata: const {
          'bookUpdate': {'contentRevision': 2},
        },
        createdAt: DateTime.utc(2026, 10, 17, 17, 34, 3),
      ),
    ]);

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pump();
    for (var frame = 0; frame < 6; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(bubbleText(_done), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-book-updating')), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-book-open')), findsNothing);
    // Below the reply, not somewhere above it.
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('chat-book-updating'))).dy,
      greaterThan(tester.getTopLeft(bubbleText(_done)).dy),
    );

    projects.emitStatus(
      projectStatus(
        status: 'complete',
        progressPercent: 100,
        currentAction: '',
        exports: _exports(revision: 2),
      ),
    );
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.byKey(const ValueKey('chat-book-updating')), findsNothing);
    expect(find.byKey(const ValueKey('chat-book-open')), findsOneWidget);
    expect(find.text('Your book is ready with this change.'), findsOneWidget);

    await tester.teardownScreen();
  });
}
