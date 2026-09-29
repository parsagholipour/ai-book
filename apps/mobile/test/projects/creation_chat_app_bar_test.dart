import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The top bar says where you are and keeps two things in reach; everything else
// lives in one overflow, so no icon has to be guessed at.

const _more = ValueKey('chat-app-bar-more');

Finder _inBar(Finder finder) =>
    find.descendant(of: find.byType(AppBar), matching: finder);

void main() {
  testWidgets('a new chat is titled, with settings and one overflow', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    expect(_inBar(find.text('New book')), findsOneWidget);
    expect(find.byTooltip('Advanced settings'), findsOneWidget);
    expect(find.byTooltip('Open book'), findsNothing);
    expect(find.byTooltip('More options'), findsOneWidget);
    // The drawer button, one action and the overflow; the old row of five bare
    // icons is gone.
    expect(_inBar(find.byType(IconButton)), findsNWidgets(3));

    await tester.tap(find.byKey(_more));
    await tester.pumpAndSettle();
    expect(find.text('Account'), findsOneWidget);
    expect(find.text('Refresh'), findsNothing);

    await tester.tapAt(const Offset(4, 4));
    await tester.pumpAndSettle();
    await tester.teardownScreen();
  });

  testWidgets('the overflow reaches the account', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: PlanProjectsRepository(),
        initialLocation: '/books/new?fresh=true&r=bar',
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(_more));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Account'));
    await tester.pumpAndSettle();

    expect(find.text('Account'), findsOneWidget);
    expect(find.byType(AppBar), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('a built book swaps settings for Open book and adds Refresh', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: PlanProjectsRepository(),
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pumpAndSettle();

    expect(_inBar(find.text('Your book')), findsOneWidget);
    expect(find.byTooltip('Open book'), findsOneWidget);
    expect(find.byTooltip('Advanced settings'), findsNothing);

    await tester.tap(find.byKey(_more));
    await tester.pumpAndSettle();
    expect(find.text('Refresh'), findsOneWidget);
    expect(find.text('New book'), findsOneWidget);

    await tester.tapAt(const Offset(4, 4));
    await tester.pumpAndSettle();
    await tester.teardownScreen();
  });
}
