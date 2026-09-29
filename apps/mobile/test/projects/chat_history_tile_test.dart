import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import 'chat_history_drawer_harness.dart';

void main() {
  testWidgets('only a chat whose book is being written shows activity', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawerApp(
        sessions: [
          chatSession(
            draftId: 'draft-live',
            title: 'Being written',
            activeProjectId: 'book-1',
          ),
          chatSession(draftId: 'draft-idle', title: 'Just a chat'),
        ],
        activeDraftId: 'other',
        projects: [drawerProject(id: 'book-1', status: 'generating')],
      ),
    );
    await pumpDrawer(tester);

    expect(spinnerIn('Being written'), findsOneWidget);
    expect(glyphIn('Being written'), findsNothing);
    // The chat next to it is untouched: one book being written does not make
    // the whole history look busy.
    expect(spinnerIn('Just a chat'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Just a chat'),
      40,
      // The list's own scrollable, not the shelf's horizontal one above it.
      scrollable: find
          .descendant(
            of: find.byType(CustomScrollView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(glyphIn('Just a chat'), findsOneWidget);
  });

  testWidgets('a chat whose book is finished shows its cover, not a spinner', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawerApp(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Finished book',
            activeProjectId: 'book-1',
          ),
        ],
        activeDraftId: 'other',
        projects: [drawerProject(id: 'book-1', status: 'complete')],
      ),
    );
    await tester.pumpAndSettle();

    expect(spinnerIn('Finished book'), findsNothing);
    expect(coverIn('Finished book'), findsOneWidget);
    expect(glyphIn('Finished book'), findsNothing);
  });

  testWidgets('a chat without a book keeps the chat glyph and its last words', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawerApp(
        sessions: [chatSession(draftId: 'draft-idle', title: 'Just a chat')],
        activeDraftId: 'other',
      ),
    );
    await tester.pumpAndSettle();

    expect(glyphIn('Just a chat'), findsOneWidget);
    expect(coverIn('Just a chat'), findsNothing);
    // Time first, then what was said: the preview is the tail of the row.
    expect(find.textContaining('· Latest message'), findsOneWidget);
  });

  testWidgets('a book chat says what state its book is in', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      drawerApp(
        sessions: [
          chatSession(
            draftId: 'draft-a',
            title: 'Neymar and the World Cup',
            activeProjectId: 'book-1',
          ),
          chatSession(
            draftId: 'draft-b',
            title: 'Neymar and the Santos years',
            activeProjectId: 'book-2',
          ),
        ],
        activeDraftId: 'other',
        projects: [
          drawerProject(id: 'book-1', status: 'complete', ready: true),
          drawerProject(id: 'book-2', status: 'failed'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    // Two chats that begin with the same words are told apart by the state of
    // the book each one made.
    expect(
      find.descendant(
        of: find.widgetWithText(ListTile, 'Neymar and the World Cup'),
        matching: find.text('Ready'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.widgetWithText(ListTile, 'Neymar and the Santos years'),
        matching: find.text('Needs attention'),
      ),
      findsOneWidget,
    );
  });

  // The list the drawer opened with is a snapshot: a book that settles while
  // the drawer stays open is only reported by its status stream, and a book
  // still being planned has no shelf card asking for it either.
  testWidgets(
    'the status stream stops the spinner before the list catches up',
    (tester) async {
      final statuses = StreamController<MobileProjectStatus>.broadcast();
      addTearDown(statuses.close);

      await tester.pumpWidget(
        drawerApp(
          sessions: [
            chatSession(
              draftId: 'draft-live',
              title: 'Being planned',
              activeProjectId: 'book-1',
            ),
          ],
          activeDraftId: 'other',
          // Still 'planning' for the whole test: only the stream ever says the
          // book is done.
          projects: [drawerProject(id: 'book-1', status: 'planning')],
          statuses: statuses.stream,
        ),
      );
      await pumpDrawer(tester);

      expect(spinnerIn('Being planned'), findsOneWidget);

      statuses.add(drawerStatus(id: 'book-1', status: 'complete'));
      await tester.pumpAndSettle();

      expect(spinnerIn('Being planned'), findsNothing);
      expect(coverIn('Being planned'), findsOneWidget);
    },
  );
}
