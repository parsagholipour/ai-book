import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/gemini_live_socket.dart';
import 'package:tomeza/features/voice/data/voice_call_audio.dart';
import 'package:tomeza/features/voice/data/voice_call_recorder.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// The last exchange of a call is the one worth remembering, and it is exactly
/// the one a heartbeat can be holding when the caller hangs up. These pin the
/// hand-off between the in-flight heartbeat and the end call's final drain.
void main() {
  testWidgets(
    'hanging up waits for the in-flight heartbeat, so a batch it fails to '
    'deliver still leaves with the end call',
    (tester) async {
      final repository = FakeVoiceRepository();
      final channel = FakeWebSocketChannel();
      final container = ProviderContainer(
        overrides: [voiceRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        voiceCallControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(voiceCallControllerProvider.notifier);

      await controller.dial(
        projectId: 'project-1',
        character: keeper,
        audio: FakeVoiceCallAudio(),
        recorder: FakeVoiceCallRecorder(),
        socketConnector: ({required token, required model, sessionHandle}) =>
            GeminiLiveSocket.connect(
              token: token,
              model: model,
              sessionHandle: sessionHandle,
              channelFactory: (_) => channel,
            ),
      );
      await tester.pump();
      expect(
        container.read(voiceCallControllerProvider).phase,
        VoiceCallPhase.connected,
      );

      // A finished line settles into the transcript queue.
      channel.incoming.add(
        jsonEncode({
          'serverContent': {
            'outputTranscription': {
              'text': 'I keep the light.',
              'finished': true,
            },
          },
        }),
      );
      await tester.pump();

      // The next heartbeat takes that line and stalls on the wire.
      final gate = repository.heartbeatGate = Completer<void>();
      repository.failNextHeartbeat = true;
      await tester.pump(const Duration(seconds: 5));
      expect(repository.heartbeats, hasLength(1));
      expect(repository.heartbeats.single, isNotEmpty);

      // hangUp's teardown awaits subscription cancels, whose completion hops
      // through the real event loop — invisible to tester.pump alone. So the
      // call is driven by alternating a real yield with a pump; awaiting it
      // bare would deadlock the fake clock.
      final hangs = controller.hangUp();
      var settled = false;
      unawaited(hangs.whenComplete(() => settled = true));
      for (var i = 0; i < 10; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump();
      }
      // The heartbeat is still on the wire, so the batch's fate is unknown —
      // hanging up must not have settled the call yet, let alone drained a
      // queue whose lines are out with the heartbeat.
      expect(repository.endedWith, isNull);
      expect(settled, isFalse);

      // Now the heartbeat fails: its batch goes back into the queue, and only
      // then may the final drain run.
      gate.complete();
      for (var i = 0; i < 20 && !settled; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump();
      }
      expect(settled, isTrue);

      // The heartbeat failed after taking the batch; the restore has to land
      // before the drain, or the line is returned to a queue nothing reads.
      expect(repository.endedWith, isNotNull);
      expect(
        repository.endedWith!.map((line) => line.text),
        contains('I keep the light.'),
      );
    },
  );
}

const keeper = VoiceCharacter(
  id: 'character-1',
  projectId: 'project-1',
  name: 'The Keeper',
  role: 'Lighthouse keeper',
  description: 'Keeps the light.',
  traits: [],
  status: VoiceCharacterStatus.ready,
  needsPreparation: false,
);

class FakeVoiceRepository implements VoiceRepository {
  Completer<void>? heartbeatGate;
  bool failNextHeartbeat = false;
  final heartbeats = <List<VoiceCallCaption>>[];
  List<VoiceCallCaption>? endedWith;

  @override
  Future<VoiceCast> getCast(String projectId) async => const VoiceCast(
    characters: [],
    creditsPerMinute: 10,
    creditsToStart: 10,
    availableCredits: 1000,
    maxCallSeconds: 600,
  );

  @override
  Future<VoiceCallSession> startCall({
    required String projectId,
    required String characterId,
    int? pageIndex,
  }) async => const VoiceCallSession(
    callId: 'call-1',
    characterId: 'character-1',
    characterName: 'The Keeper',
    token: 'auth_tokens/test',
    model: 'gemini-live-test',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    secondsRemaining: 300,
    creditsPerMinute: 10,
    heartbeatSeconds: 5,
    maxCallSeconds: 600,
  );

  @override
  Future<VoiceCallMeter> heartbeat({
    required String callId,
    required int elapsedSeconds,
    List<VoiceCallCaption> messages = const [],
  }) async {
    heartbeats.add(messages);
    final gate = heartbeatGate;
    if (gate != null) {
      heartbeatGate = null;
      await gate.future;
    }
    if (failNextHeartbeat) {
      failNextHeartbeat = false;
      throw Exception('offline');
    }
    return VoiceCallMeter(
      elapsedSeconds: elapsedSeconds,
      secondsRemaining: 290,
      chargedCredits: 10,
      endingSoon: false,
    );
  }

  @override
  Future<VoiceCallMeter> endCall({
    required String callId,
    required int elapsedSeconds,
    String reason = 'ended',
    List<VoiceCallCaption> messages = const [],
  }) async {
    endedWith = messages;
    return VoiceCallMeter(
      elapsedSeconds: elapsedSeconds,
      secondsRemaining: 0,
      chargedCredits: 10,
      endingSoon: false,
    );
  }
}

class FakeVoiceCallAudio implements VoiceCallAudio {
  final mic = StreamController<Uint8List>();

  @override
  Future<bool> ensurePermission() async => true;

  @override
  Future<Stream<Uint8List>> start({
    required int inputSampleRate,
    required int outputSampleRate,
    required bool speakerphone,
  }) async => mic.stream;

  @override
  Future<void> play(Uint8List pcm16) async {}

  @override
  Future<void> flushPlayback() async {}

  @override
  Future<void> setMuted(bool muted) async {}

  @override
  Future<void> setSpeakerphone(bool enabled) async {}

  @override
  Future<void> stop() async {}
}

/// A recorder that refuses to open its spool, which the controller treats as
/// "this call is not recorded" — the path with no filesystem behind it.
class FakeVoiceCallRecorder implements VoiceCallRecorder {
  @override
  Future<bool> start(String callId) async => false;

  @override
  Future<void> dispose() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeWebSocketChannel implements WebSocketChannel {
  final incoming = StreamController<dynamic>();
  final sent = <dynamic>[];
  late final _FakeWebSocketSink _sink = _FakeWebSocketSink(this);

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<dynamic> get stream => incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  String? get protocol => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeWebSocketSink implements WebSocketSink {
  _FakeWebSocketSink(this.channel);

  final FakeWebSocketChannel channel;

  @override
  void add(dynamic data) => channel.sent.add(data);

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
