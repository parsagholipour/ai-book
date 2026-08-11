import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/voice_call_audio.dart';
import 'package:tomeza/features/voice/data/voice_call_recorder.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:tomeza/features/voice/presentation/voice_call_screen.dart';

const marlow = VoiceCharacter(
  id: 'character-1',
  projectId: 'project-1',
  name: 'Marlow',
  role: 'The lighthouse keeper',
  description: 'Keeps the light.',
  traits: [],
  status: VoiceCharacterStatus.ready,
  needsPreparation: false,
);

/// Holds one fixed state and never dials, so the screen can be inspected in
/// each phase without a microphone or a socket.
class StubVoiceCallController extends VoiceCallController {
  StubVoiceCallController(this._initial);

  final VoiceCallState _initial;
  int hangUpCalls = 0;
  int exportCalls = 0;

  /// What `exportRecording` hands back. Null stands in for "there was nothing
  /// to export", which the screen has to survive without a share sheet.
  File? exported;

  @override
  VoiceCallState build() => _initial;

  @override
  Future<void> dial({
    required String projectId,
    required VoiceCharacter character,
    int? pageIndex,
    VoiceCallAudio? audio,
    VoiceCallRecorder? recorder,
    GeminiLiveSocketConnector? socketConnector,
  }) async {}

  @override
  Future<File?> exportRecording() async {
    exportCalls += 1;
    return exported;
  }

  @override
  Future<void> hangUp({String reason = 'ended'}) async {
    hangUpCalls += 1;
  }

  @override
  Future<void> toggleMute() async {
    state = state.copyWith(muted: !state.muted);
  }
}

Future<StubVoiceCallController> pumpCall(
  WidgetTester tester,
  VoiceCallState initial,
) async {
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

void main() {
  testWidgets('names the persona build rather than showing a bare spinner', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(character: marlow, phase: VoiceCallPhase.preparing),
    );

    expect(find.text('Waking Marlow up…'), findsOneWidget);
  });

  testWidgets('shows the running call time once connected', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        elapsedSeconds: 95,
        secondsRemaining: 300,
      ),
    );

    expect(find.text('1:35'), findsOneWidget);
    expect(find.text('Marlow'), findsOneWidget);
    // The disclosure has to be on screen for the whole call, not just at the start.
    expect(find.text('AI voice'), findsOneWidget);
  });

  testWidgets('says the line is being redialled instead of failing quietly', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(character: marlow, phase: VoiceCallPhase.reconnecting),
    );

    expect(find.text('Reconnecting…'), findsOneWidget);
  });

  testWidgets('warns before a call runs out of paid time', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        elapsedSeconds: 120,
        secondsRemaining: 25,
        outOfCredits: true,
        endingReason: VoiceCallEndingReason.credits,
      ),
    );

    expect(find.text('Out of credits — ending in 25s'), findsOneWidget);
  });

  testWidgets('does not nag about time when there is plenty left', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        elapsedSeconds: 10,
        secondsRemaining: 300,
      ),
    );

    expect(find.textContaining('Ending in'), findsNothing);
  });

  testWidgets('reports what a finished call cost', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 65,
        chargedCredits: 120,
      ),
    );

    expect(find.text('Call ended · 1:05'), findsOneWidget);
    expect(find.text('120 credits'), findsOneWidget);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('shows the live transcript with the caller and character apart', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        captions: [
          VoiceCallCaption(speaker: VoiceCallSpeaker.caller, text: 'Who are you?'),
          VoiceCallCaption(speaker: VoiceCallSpeaker.character, text: 'I keep the light.'),
        ],
        liveCaptions: [
          VoiceCallCaption(
            speaker: VoiceCallSpeaker.character,
            text: 'Have done for thirty years',
          ),
        ],
      ),
    );

    expect(find.text('Who are you?'), findsOneWidget);
    expect(find.text('I keep the light.'), findsOneWidget);
    // The in-progress line shows while it is still being spoken, so the
    // captions do not lag a sentence behind the voice.
    expect(find.text('Have done for thirty years'), findsOneWidget);
  });

  testWidgets('warns for the whole runway once credits are known to be short', (tester) async {
    // The server knows a top-up failed a reserve block — minutes — before the
    // clock runs out. Waiting for the last sixty seconds wasted that warning.
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        elapsedSeconds: 60,
        secondsRemaining: 150,
        outOfCredits: true,
        endingReason: VoiceCallEndingReason.credits,
      ),
    );

    expect(find.text('Out of credits — ending in 2:30'), findsOneWidget);
  });

  testWidgets('names the length cap rather than blaming credits', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        elapsedSeconds: 1700,
        secondsRemaining: 100,
        endingReason: VoiceCallEndingReason.limit,
      ),
    );

    expect(find.text('Call limit reached — ending in 1:40'), findsOneWidget);
  });

  testWidgets('explains a call that ended on credits and offers a top-up', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 180,
        chargedCredits: 180,
        endedBecause: VoiceCallEndingReason.credits,
      ),
    );

    expect(find.text('The call ended when your credits ran out.'), findsOneWidget);
    expect(find.text('Add credits'), findsOneWidget);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('explains the length cap without offering credits', (tester) async {
    // Buying credits does not lift the cap, so offering it here would mislead.
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 1800,
        maxCallSeconds: 1800,
        endedBecause: VoiceCallEndingReason.limit,
      ),
    );

    expect(find.text('Calls stop at 30 minutes. Call again to keep talking.'), findsOneWidget);
    expect(find.text('Add credits'), findsNothing);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('a call the caller ended says nothing extra', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 65,
        chargedCredits: 120,
      ),
    );

    expect(find.textContaining('credits ran out'), findsNothing);
    expect(find.text('Add credits'), findsNothing);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('mutes and unmutes from the call controls', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(character: marlow, phase: VoiceCallPhase.connected),
    );

    expect(find.text('Mute'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('call-control-mute')));
    await tester.pump();
    expect(find.text('Unmute'), findsOneWidget);
  });

  testWidgets('keeps the reason on screen when a call failed rather than ended', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.failed,
        error: 'The call was disconnected.',
      ),
    );

    expect(find.text('The call was disconnected.'), findsOneWidget);
    expect(find.textContaining('Call ended'), findsNothing);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('settles the call when the caller backs out of the screen', (tester) async {
    final controller = await pumpCall(
      tester,
      const VoiceCallState(character: marlow, phase: VoiceCallPhase.connected),
    );

    // Backing out must hang up: otherwise the credit hold stays out until the
    // server's sweep notices the call stopped reporting.
    await tester.tap(find.byKey(const ValueKey('call-control-end')));
    await tester.pump();

    expect(controller.hangUpCalls, 1);
  });

  testWidgets('offers no menu when the call is not being recorded', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(character: marlow, phase: VoiceCallPhase.connected),
    );

    expect(find.byKey(const ValueKey('call-menu')), findsNothing);
    // And the disclosure must not claim a recording that is not happening.
    expect(find.text('AI voice'), findsOneWidget);
  });

  testWidgets('discloses the recording alongside the AI voice notice', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        recordingAvailable: true,
      ),
    );

    expect(find.byKey(const ValueKey('call-menu')), findsOneWidget);
    expect(find.text('AI voice · recorded on this device'), findsOneWidget);
  });

  testWidgets('asks before it shares, and does nothing on cancel', (tester) async {
    final controller = await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        recordingAvailable: true,
      ),
    );

    await tester.tap(find.byKey(const ValueKey('call-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('call-menu-download')));
    await tester.pumpAndSettle();

    // The dialog names whose voices are in the file before the share sheet —
    // a list of every app that will take audio — is anywhere near the screen.
    expect(find.textContaining('your call with Marlow'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(controller.exportCalls, 0);
  });

  testWidgets('exports once the caller proceeds', (tester) async {
    final controller = await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.connected,
        recordingAvailable: true,
      ),
    );

    await tester.tap(find.byKey(const ValueKey('call-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('call-menu-download')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('call-recording-proceed')));
    await tester.pumpAndSettle();

    // Nothing to share, so the share sheet is never reached — which is what
    // keeps this test off the platform channel.
    expect(controller.exportCalls, 1);
  });

  testWidgets('keeps the recording reachable after the caller hangs up', (tester) async {
    // Hanging up used to pop straight back to the book. With a recording on
    // disk that would throw it away a beat before the caller was offered it.
    final controller = await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 65,
        chargedCredits: 120,
        recordingAvailable: true,
      ),
    );

    expect(controller.hangUpCalls, 0);
    expect(find.byKey(const ValueKey('call-menu')), findsOneWidget);
    expect(find.text('The recording is under the menu, top right.'), findsOneWidget);
    expect(find.text('Back to the book'), findsOneWidget);
  });

  testWidgets('keeps the failure reason on screen while exporting', (tester) async {
    // `copyWith` drops the error unless it is handed back, so flipping the
    // exporting flag on a failed call used to replace the real reason with the
    // generic one — while the caller was looking at it.
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.failed,
        error: 'The call was disconnected.',
        recordingAvailable: true,
        exportingRecording: true,
      ),
    );

    expect(find.text('The call was disconnected.'), findsOneWidget);
    // And the menu makes way for the progress indicator rather than sitting
    // next to one.
    expect(find.byKey(const ValueKey('call-menu')), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('says nothing about a recording that was never made', (tester) async {
    await pumpCall(
      tester,
      const VoiceCallState(
        character: marlow,
        phase: VoiceCallPhase.ended,
        elapsedSeconds: 65,
      ),
    );

    expect(find.textContaining('recording'), findsNothing);
  });
}
