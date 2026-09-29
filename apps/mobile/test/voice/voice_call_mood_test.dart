import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:tomeza/features/voice/presentation/voice_call_stage.dart';

import 'voice_call_screen_test.dart' show marlow, pumpCall;

/// What the caller is told the line is doing: listening, thinking, speaking.
void main() {
  const said = VoiceCallCaption(
    speaker: VoiceCallSpeaker.caller,
    text: 'Who lit the lamp?',
  );
  const reply = VoiceCallCaption(
    speaker: VoiceCallSpeaker.character,
    text: 'My mother did',
  );

  VoiceCallState connected({
    bool muted = false,
    bool speaking = false,
    List<VoiceCallCaption> live = const [],
  }) => VoiceCallState(
    character: marlow,
    phase: VoiceCallPhase.connected,
    muted: muted,
    characterSpeaking: speaking,
    liveCaptions: live,
  );

  group('callMoodOf', () {
    test('an open line with nothing in flight is listening', () {
      expect(
        callMoodOf(connected(), callerQuiet: false),
        VoiceCallMood.listening,
      );
    });

    test('a caption still growing is a caller still talking, not thinking', () {
      expect(
        callMoodOf(connected(live: const [said]), callerQuiet: false),
        VoiceCallMood.listening,
      );
    });

    test('a caller gone quiet with no reply yet is thinking', () {
      expect(
        callMoodOf(connected(live: const [said]), callerQuiet: true),
        VoiceCallMood.thinking,
      );
    });

    test('a reply in flight is speaking, even before its audio arrives', () {
      expect(
        callMoodOf(connected(live: const [said, reply]), callerQuiet: true),
        VoiceCallMood.speaking,
      );
      expect(
        callMoodOf(connected(speaking: true), callerQuiet: false),
        VoiceCallMood.speaking,
      );
    });

    test('a muted caller still hears the reply', () {
      expect(
        callMoodOf(connected(muted: true), callerQuiet: false),
        VoiceCallMood.muted,
      );
      expect(
        callMoodOf(connected(muted: true, speaking: true), callerQuiet: false),
        VoiceCallMood.speaking,
      );
    });

    test(
      'the phases before and after the conversation keep their own moods',
      () {
        VoiceCallMood of(VoiceCallPhase phase) => callMoodOf(
          VoiceCallState(character: marlow, phase: phase),
          callerQuiet: false,
        );
        expect(of(VoiceCallPhase.ringing), VoiceCallMood.connecting);
        expect(of(VoiceCallPhase.preparing), VoiceCallMood.preparing);
        expect(of(VoiceCallPhase.reconnecting), VoiceCallMood.reconnecting);
        expect(of(VoiceCallPhase.ended), VoiceCallMood.ended);
        expect(of(VoiceCallPhase.failed), VoiceCallMood.failed);
      },
    );
  });

  testWidgets('names who is speaking', (tester) async {
    await pumpCall(tester, connected(speaking: true));

    expect(find.text('Marlow is speaking'), findsOneWidget);
  });

  testWidgets('says thinking only once the caller has gone quiet', (
    tester,
  ) async {
    await pumpCall(tester, connected(live: const [said]));

    expect(find.text('Listening'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1400));
    // One more frame for the pill's cross-fade to let the old label go.
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Thinking…'), findsOneWidget);
    expect(find.text('Listening'), findsNothing);
  });

  testWidgets('says the caller is muted', (tester) async {
    await pumpCall(tester, connected(muted: true));

    expect(find.text('You are muted'), findsOneWidget);
    expect(
      find.text('You are muted. Tap the microphone to talk.'),
      findsOneWidget,
    );
  });

  testWidgets('offers to ring again after a call ends, and does', (
    tester,
  ) async {
    final controller = await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 65,
      ),
    );

    // The screen dials once when it opens; ringing again is a second dial.
    final before = controller.dialCalls;
    await tester.tap(find.text('Call again'));
    await tester.pump();

    expect(controller.dialCalls, before + 1);
  });

  testWidgets('a call that failed leads with ringing again', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.failed,
        error: 'The call was disconnected.',
      ),
    );

    expect(find.text('Call again'), findsOneWidget);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('a refused microphone says how to fix it', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.failed,
        error: 'Tomeza needs microphone access to place the call.',
      ),
    );

    expect(find.textContaining('Settings'), findsOneWidget);
    expect(find.text('Call again'), findsOneWidget);
  });

  testWidgets(
    'a call that ended for want of credits does not offer to ring again',
    (tester) async {
      await pumpCall(
        tester,
        const VoiceCallState(
          character: marlow,
          phase: VoiceCallPhase.ended,
          endedBecause: VoiceCallEndingReason.credits,
        ),
      );

      expect(find.text('Add credits'), findsOneWidget);
      expect(find.text('Call again'), findsNothing);
    },
  );
}
