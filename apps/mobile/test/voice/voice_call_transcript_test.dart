import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:tomeza/features/voice/presentation/voice_call_screen.dart';

import 'voice_call_screen_test.dart' show StubVoiceCallController, marlow;

/// Scroll behaviour of the live transcript.
///
/// Following a feed that is written to several times a second is where this
/// screen looked buggy, so each rule it depends on is pinned here.
List<VoiceCallCaption> captions(int count) {
  return List.generate(
    count,
    (index) => VoiceCallCaption(
      speaker: index.isEven ? VoiceCallSpeaker.character : VoiceCallSpeaker.caller,
      text: 'Line $index — long enough to take real vertical space on screen.',
    ),
  );
}

VoiceCallState liveState({
  required List<VoiceCallCaption> lines,
  int elapsedSeconds = 0,
  List<VoiceCallCaption> live = const [],
}) {
  return VoiceCallState(
    character: marlow,
    phase: VoiceCallPhase.connected,
    captions: lines,
    liveCaptions: live,
    elapsedSeconds: elapsedSeconds,
  );
}

Future<StubVoiceCallController> pump(WidgetTester tester, VoiceCallState initial) async {
  final controller = StubVoiceCallController(initial);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [voiceCallControllerProvider.overrideWith(() => controller)],
      child: const MaterialApp(
        home: VoiceCallScreen(projectId: 'project-1', character: marlow),
      ),
    ),
  );
  await tester.pump();
  return controller;
}

ScrollPosition position(WidgetTester tester) =>
    tester.state<ScrollableState>(find.byType(Scrollable)).position;

void main() {
  testWidgets('follows the newest line to the bottom', (tester) async {
    final controller = await pump(tester, liveState(lines: captions(3)));

    controller.state = liveState(lines: captions(30));
    await tester.pumpAndSettle();

    final scroll = position(tester);
    expect(scroll.pixels, moreOrLessEquals(scroll.maxScrollExtent, epsilon: 1));
  });

  testWidgets('opens on the newest line when it mounts with a transcript', (tester) async {
    // A rebuilt screen should not drop the reader at the top of the call.
    await pump(tester, liveState(lines: captions(30)));
    await tester.pumpAndSettle();

    final scroll = position(tester);
    expect(scroll.pixels, moreOrLessEquals(scroll.maxScrollExtent, epsilon: 1));
  });

  testWidgets('does not scroll when only the call timer ticked', (tester) async {
    // The controller rebuilds this screen once a second. Scrolling on that
    // kicked the transcript through every silence.
    final lines = captions(30);
    final controller = await pump(tester, liveState(lines: lines));
    await tester.pumpAndSettle();

    position(tester).jumpTo(0);
    await tester.pump();

    controller.state = liveState(lines: lines, elapsedSeconds: 1);
    await tester.pumpAndSettle();

    expect(position(tester).pixels, 0);
  });

  testWidgets('leaves the reader where they scrolled to', (tester) async {
    final controller = await pump(tester, liveState(lines: captions(30)));
    await tester.pumpAndSettle();

    // Drag downward = move back up through the transcript.
    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();
    final parked = position(tester).pixels;
    expect(parked, lessThan(position(tester).maxScrollExtent));

    controller.state = liveState(lines: captions(34));
    await tester.pumpAndSettle();

    expect(position(tester).pixels, parked);
  });

  testWidgets('resumes following once the reader returns to the bottom', (tester) async {
    final controller = await pump(tester, liveState(lines: captions(30)));
    await tester.pumpAndSettle();

    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();
    // Far enough to land on the end stop, whatever the transcript measures.
    await tester.drag(find.byType(ListView), const Offset(0, -4000));
    await tester.pumpAndSettle();

    controller.state = liveState(lines: captions(34));
    await tester.pumpAndSettle();

    final scroll = position(tester);
    expect(scroll.pixels, moreOrLessEquals(scroll.maxScrollExtent, epsilon: 1));
  });

  testWidgets('holds its height steady while the call timer ticks', (tester) async {
    // The status line above the transcript animates on phase changes. Keying
    // that animation on the label meant the ticking clock re-ran it every
    // second, growing a fresh child from zero height and bouncing everything
    // below it.
    final lines = captions(30);
    final controller = await pump(tester, liveState(lines: lines));
    await tester.pumpAndSettle();
    final settled = tester.getRect(find.byType(ListView));

    for (var second = 1; second <= 3; second += 1) {
      controller.state = liveState(lines: lines, elapsedSeconds: second);
      // Sampled mid-transition, where a size animation would be visible.
      await tester.pump(const Duration(milliseconds: 60));
      expect(tester.getRect(find.byType(ListView)), settled);
      await tester.pump(const Duration(milliseconds: 120));
      expect(tester.getRect(find.byType(ListView)), settled);
    }
  });

  testWidgets('shows the caller their own words while the reply is still coming', (tester) async {
    // A single live caption with the character's winning hid the caller's own
    // words for as long as the reply took to speak.
    await pump(
      tester,
      liveState(
        lines: const [],
        live: const [
          VoiceCallCaption(speaker: VoiceCallSpeaker.caller, text: 'Who are you?'),
          VoiceCallCaption(speaker: VoiceCallSpeaker.character, text: 'I keep the'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Who are you?'), findsOneWidget);
    expect(find.text('I keep the'), findsOneWidget);
    // And in the order they were spoken.
    expect(
      tester.getTopLeft(find.text('Who are you?')).dy,
      lessThan(tester.getTopLeft(find.text('I keep the')).dy),
    );
  });

  testWidgets('keeps up with a caption that grows while it is spoken', (tester) async {
    // The live line gets taller as words arrive, so the extent captured when a
    // scroll was scheduled is stale by the time it runs.
    final lines = captions(30);
    final controller = await pump(tester, liveState(lines: lines));
    await tester.pumpAndSettle();

    var text = 'I keep the light';
    for (var word = 0; word < 12; word += 1) {
      text = '$text and the nights are long';
      controller.state = liveState(
        lines: lines,
        live: [VoiceCallCaption(speaker: VoiceCallSpeaker.character, text: text)],
      );
      await tester.pump(const Duration(milliseconds: 40));
    }
    await tester.pumpAndSettle();

    final scroll = position(tester);
    expect(scroll.pixels, moreOrLessEquals(scroll.maxScrollExtent, epsilon: 1));
  });
}
