import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/chat_assistant_avatar.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// How the transcript frames what was said: runs of one speaker read as one turn,
// the day is named once, and the way back to the newest message shows up when
// the reader has left it.

ScriptedCreationRepository _chat(List<Map<String, dynamic>> messages) {
  final creation = ScriptedCreationRepository(
    sessions: [chatSession(draftId: 'draft-x', title: 'Chat')],
  );
  creation.resumeMessages['draft-x'] = messages;
  return creation;
}

Map<String, dynamic> _message(
  String id,
  String role,
  String content,
  DateTime at,
) => {
  'id': id,
  'role': role,
  'content': content,
  'createdAt': at.toUtc().toIso8601String(),
};

void main() {
  final now = DateTime.now();
  final noon = DateTime(now.year, now.month, now.day, 12);

  testWidgets('same-speaker messages share one avatar, one time and one day', (
    tester,
  ) async {
    final creation = _chat([
      _message('a1', 'assistant', 'Tell me more', noon),
      _message('u1', 'user', 'A story', noon.add(const Duration(minutes: 1))),
      _message(
        'u2',
        'user',
        'About dragons',
        noon.add(const Duration(minutes: 1)),
      ),
      _message(
        'a2',
        'assistant',
        'Lovely idea',
        noon.add(const Duration(minutes: 2)),
      ),
    ]);
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-x'));
    await tester.pumpAndSettle();

    expect(find.text('Today'), findsOneWidget);
    // Two assistant turns, two avatars; the two user lines are one turn.
    expect(find.byType(ChatAssistantAvatar), findsNWidgets(2));
    expect(find.text('12:01 PM'), findsOneWidget);
    expect(find.text('12:00 PM'), findsOneWidget);
    expect(find.text('12:02 PM'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a gap or a new day starts a new turn', (tester) async {
    final creation = _chat([
      _message('u1', 'user', 'First thought', noon),
      _message(
        'u2',
        'user',
        'Much later',
        noon.add(const Duration(minutes: 40)),
      ),
      _message(
        'u3',
        'user',
        'Days before',
        noon.subtract(const Duration(days: 3, minutes: 5)),
      ),
    ]);
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-x'));
    await tester.pumpAndSettle();

    // Both of today's lines carry their own time: forty minutes is a new turn.
    expect(find.text('12:00 PM'), findsOneWidget);
    expect(find.text('12:40 PM'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('leaving the newest message offers a way back', (tester) async {
    final creation = _chat([
      for (var i = 0; i < 30; i++)
        _message(
          'm$i',
          i.isEven ? 'assistant' : 'user',
          'Message number $i, long enough to take a little room in the list.',
          noon.add(Duration(minutes: i * 10)),
        ),
    ]);
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-x'));
    await tester.pumpAndSettle();
    // The list follows the conversation down on timers, which settling does not
    // wait for.
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
    }

    // The button is always mounted; whether it is offered is its opacity.
    final jump = find.byIcon(Icons.arrow_downward_rounded);
    double offered() => tester
        .widget<AnimatedOpacity>(
          find.ancestor(of: jump, matching: find.byType(AnimatedOpacity)),
        )
        .opacity;

    // At the bottom: nothing to jump to.
    expect(offered(), 0);

    await tester.drag(find.byType(ListView).first, const Offset(0, 900));
    await tester.pumpAndSettle();
    expect(offered(), 1);

    await tester.tap(jump);
    await tester.pumpAndSettle();
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
    }
    expect(offered(), 0);

    await tester.teardownScreen();
  });
}
