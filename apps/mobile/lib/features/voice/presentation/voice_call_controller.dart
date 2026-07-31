import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../data/gemini_live_socket.dart';
import '../data/voice_call_audio.dart';
import '../data/voice_repository.dart';
import '../domain/voice_models.dart';
import '../domain/voice_transcript_queue.dart';

/// Drives one call from "tap a name" to "hung up".
///
/// The shape follows `BrowserVoiceCallClient` on the web: connect with retries,
/// resume with a session handle rather than reintroducing the character, and
/// keep the transcript so a reconnect can pick the conversation back up. What
/// mobile adds is the credit meter and the caption feed — the transcript the web
/// client throws away is worth showing on a phone, where a call happens in
/// pockets, on buses, and by people who would rather read than listen.
class VoiceCallController extends Notifier<VoiceCallState> {
  static const _retryDelays = [
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];
  static const _maxAttempts = 5;

  /// How long the app keeps ringing while the persona builds. The build is a
  /// single model call, so this is generous; past it, something is wrong.
  static const _prepareTimeout = Duration(seconds: 45);
  static const _prepareRetryDelay = Duration(seconds: 3);
  static const _captionLimit = 40;

  /// Finished lines on their way to the server, where they become what this
  /// character remembers the next time the reader calls. Separate from
  /// [VoiceCallState.captions], which is a capped display buffer and drops the
  /// start of a long call.
  final _transcriptQueue = VoiceTranscriptQueue();

  VoiceCallAudio? _audio;
  GeminiLiveSocket? _socket;
  StreamSubscription<Uint8List>? _micSubscription;
  StreamSubscription<GeminiLiveEvent>? _socketSubscription;
  Timer? _ticker;
  Timer? _heartbeatTimer;

  VoiceCallSession? _session;
  String _sessionHandle = '';
  String _pendingCallerCaption = '';
  String _pendingCharacterCaption = '';
  DateTime? _connectedAt;
  int _elapsedBeforeReconnect = 0;
  bool _disposed = false;
  bool _reconnecting = false;
  bool _hangingUp = false;
  int _connectionSequence = 0;

  @override
  VoiceCallState build() {
    ref.onDispose(() {
      _disposed = true;
      unawaited(_teardown());
    });
    return const VoiceCallState();
  }

  /// Places the call. [pageIndex] is where the reader was, when the call came
  /// from the reader — it scopes what the character will talk about.
  Future<void> dial({
    required String projectId,
    required VoiceCharacter character,
    int? pageIndex,
    VoiceCallAudio? audio,
  }) async {
    // A controller that has already carried a call can carry another: the
    // provider is auto-disposed, but not the instant the screen pops, so a
    // second call placed straight after the first must not be swallowed.
    if (state.isLive || state.phase == VoiceCallPhase.ringing || state.phase == VoiceCallPhase.preparing) {
      return;
    }
    _resetForNewCall();
    state = VoiceCallState(character: character, phase: VoiceCallPhase.ringing);

    final io = audio ?? PlatformVoiceCallAudio();
    _audio = io;
    if (!await io.ensurePermission()) {
      state = state.copyWith(
        phase: VoiceCallPhase.failed,
        error: 'Tomeza needs microphone access to place the call.',
      );
      return;
    }

    try {
      final session = await _startSession(projectId, character, pageIndex);
      if (_disposed) return;
      _session = session;
      state = state.copyWith(
        phase: VoiceCallPhase.ringing,
        secondsRemaining: session.secondsRemaining,
        creditsPerMinute: session.creditsPerMinute,
        maxCallSeconds: session.maxCallSeconds,
      );
      await _connectWithRetries(projectId, character, pageIndex);
    } on InsufficientCreditsForCallException catch (error) {
      state = state.copyWith(phase: VoiceCallPhase.failed, error: error.message, outOfCredits: true);
    } catch (error) {
      state = state.copyWith(phase: VoiceCallPhase.failed, error: userFacingError(error));
      await _teardown();
    }
  }

  Future<void> toggleMute() async {
    final muted = !state.muted;
    state = state.copyWith(muted: muted);
    await _audio?.setMuted(muted);
    // Telling Gemini the caller's turn is over stops it waiting on a stream
    // that will not produce anything until the mic comes back.
    if (muted) {
      _socket?.sendAudioStreamEnd();
    }
  }

  Future<void> toggleSpeakerphone() async {
    final enabled = !state.speakerphone;
    state = state.copyWith(speakerphone: enabled);
    await _audio?.setSpeakerphone(enabled);
  }

  /// Hangs up and settles the meter. Safe to call more than once.
  Future<void> hangUp({String reason = 'ended'}) async {
    if (state.phase == VoiceCallPhase.ended || state.phase == VoiceCallPhase.idle) {
      return;
    }
    // Settling is asynchronous and the phase only flips to `ended` once it
    // finishes, so without this the one-second ticker calls in again while the
    // first settlement is still in flight — a second POST /end, a second
    // rate-limit attempt, and two settlements racing over one call.
    if (_hangingUp) {
      return;
    }
    _hangingUp = true;
    // Whatever was mid-sentence when the line went is still something that was
    // said, and the last exchange of a call is the one worth remembering.
    _flushCaption(VoiceCallSpeaker.caller);
    _flushCaption(VoiceCallSpeaker.character);
    final elapsed = _elapsedSeconds();
    final callId = _session?.callId;
    _connectionSequence += 1;
    await _teardown();

    var charged = state.chargedCredits;
    if (callId != null) {
      final meter = await ref
          .read(voiceRepositoryProvider)
          .endCall(
            callId: callId,
            elapsedSeconds: elapsed,
            reason: reason,
            messages: _transcriptQueue.drain(),
          )
          .catchError((_) => VoiceCallMeter(
                elapsedSeconds: elapsed,
                secondsRemaining: 0,
                chargedCredits: charged,
                endingSoon: true,
              ));
      charged = meter.chargedCredits;
      // The balance moved, and the cast sheet and shelf both show it.
      ref.invalidate(billingProvider);
    }
    _hangingUp = false;
    if (_disposed) return;
    // A call that failed stays failed. `copyWith` drops the error unless it is
    // passed again, and "Call ended" in place of the reason would leave the
    // caller with no idea why the line went.
    final failed = state.phase == VoiceCallPhase.failed;
    state = state.copyWith(
      phase: failed ? VoiceCallPhase.failed : VoiceCallPhase.ended,
      error: failed ? state.error : null,
      elapsedSeconds: elapsed,
      chargedCredits: charged,
      secondsRemaining: 0,
      endedBecause: switch (reason) {
        'out_of_credits' => VoiceCallEndingReason.credits,
        'time_limit' => VoiceCallEndingReason.limit,
        _ => null,
      },
    );
  }

  /// Waits for a character's persona build by polling the cast, which is a
  /// plain read with no rate limit and no side effects.
  ///
  /// Returns as soon as they are callable, or when [deadline] passes — the
  /// caller retries the real call either way, so a cast read that fails is
  /// just a slower path, not a failure.
  Future<void> _waitForCharacterReady(
    String projectId,
    VoiceCharacter character,
    DateTime deadline,
  ) async {
    final repository = ref.read(voiceRepositoryProvider);
    while (!_disposed && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(_prepareRetryDelay);
      if (_disposed) return;
      try {
        final cast = await repository.getCast(projectId);
        final current = cast.characters.where((entry) => entry.id == character.id).firstOrNull;
        if (current == null || current.status == VoiceCharacterStatus.ready) {
          return;
        }
      } catch (_) {
        // The cast read is only a hint. Fall back to trying the call again.
        return;
      }
    }
  }

  /// Clears the leftovers of a previous call on this controller.
  void _resetForNewCall() {
    _session = null;
    _sessionHandle = '';
    _transcriptQueue.clear();
    _pendingCallerCaption = '';
    _pendingCharacterCaption = '';
    _connectedAt = null;
    _elapsedBeforeReconnect = 0;
    _reconnecting = false;
    _hangingUp = false;
  }

  Future<VoiceCallSession> _startSession(
    String projectId,
    VoiceCharacter character,
    int? pageIndex,
  ) async {
    final repository = ref.read(voiceRepositoryProvider);
    final deadline = DateTime.now().add(_prepareTimeout);
    while (true) {
      try {
        return await repository.startCall(
          projectId: projectId,
          characterId: character.id,
          pageIndex: pageIndex,
        );
      } on VoiceCharacterPreparingException {
        // First call for this character: the persona is being built. Keep
        // ringing rather than showing an error the user cannot act on.
        if (DateTime.now().isAfter(deadline)) {
          throw Exception('${character.name} could not be reached. Try again in a minute.');
        }
        state = state.copyWith(phase: VoiceCallPhase.preparing);
        // Wait on the cheap read, not by re-posting. Placing a call reserves
        // credits and mints a provider token; asking "are they ready yet?" by
        // retrying it burned the rate-limit budget on requests that did no
        // work and locked the user out of the feature — and out of book
        // generation with it.
        await _waitForCharacterReady(projectId, character, deadline);
        if (_disposed) rethrow;
      } on ApiException catch (error) {
        if (error.code == 'INSUFFICIENT_CREDITS') {
          throw InsufficientCreditsForCallException(
            'You need more credits to start a call.',
          );
        }
        rethrow;
      }
    }
  }

  Future<void> _connectWithRetries(
    String projectId,
    VoiceCharacter character,
    int? pageIndex,
  ) async {
    Object? lastError;
    for (var attempt = 0; attempt < _maxAttempts; attempt += 1) {
      if (_disposed) return;
      if (attempt > 0) {
        state = state.copyWith(phase: VoiceCallPhase.reconnecting);
        await Future<void>.delayed(_retryDelayWithJitter(attempt - 1));
        if (_disposed) return;
      }
      try {
        await _connectOnce();
        return;
      } catch (error) {
        lastError = error;
        await _closeConnection();
      }
    }
    if (_disposed) return;
    state = state.copyWith(
      phase: VoiceCallPhase.failed,
      error: userFacingError(lastError ?? Exception('The call could not connect.')),
    );
    await hangUp(reason: 'connect_failed');
  }

  Future<void> _connectOnce() async {
    final session = _session;
    final audio = _audio;
    if (session == null || audio == null) {
      throw StateError('No call to connect.');
    }
    _connectionSequence += 1;
    final sequence = _connectionSequence;

    final socket = await GeminiLiveSocket.connect(
      token: session.token,
      model: session.model,
      sessionHandle: _sessionHandle.isEmpty ? null : _sessionHandle,
    );
    if (sequence != _connectionSequence || _disposed) {
      socket.close();
      throw StateError('The call was replaced.');
    }
    _socket = socket;
    _socketSubscription = socket.events.listen((event) => _handleEvent(event, sequence));

    final mic = await audio.start(
      inputSampleRate: session.inputSampleRate,
      outputSampleRate: session.outputSampleRate,
      speakerphone: state.speakerphone,
    );
    _micSubscription = mic.listen((chunk) {
      if (sequence == _connectionSequence && !_disposed) {
        socket.sendAudio(chunk, session.inputSampleRate);
      }
    });

    _connectedAt = DateTime.now();
    state = state.copyWith(phase: VoiceCallPhase.connected, error: null);
    _startTimers();
  }

  void _handleEvent(GeminiLiveEvent event, int sequence) {
    if (sequence != _connectionSequence || _disposed) return;

    switch (event) {
      case GeminiLiveReady():
        break;
      case GeminiLiveAudio(:final pcm16):
        state = state.copyWith(characterSpeaking: true);
        unawaited(_audio?.play(pcm16));
      case GeminiLiveInterrupted():
        // The caller talked over the character. Everything queued answers
        // something they have moved past, so it is dropped rather than played
        // out over the top of what they just said.
        state = state.copyWith(characterSpeaking: false);
        unawaited(_audio?.flushPlayback());
        _flushCaption(VoiceCallSpeaker.character);
      case GeminiLiveTranscript(:final speaker, :final text, :final finished):
        _appendCaption(
          speaker == GeminiSpeaker.user ? VoiceCallSpeaker.caller : VoiceCallSpeaker.character,
          text,
          finished,
        );
      case GeminiLiveTurnComplete():
        state = state.copyWith(characterSpeaking: false);
        _flushCaption(VoiceCallSpeaker.caller);
        _flushCaption(VoiceCallSpeaker.character);
      case GeminiLiveResumptionHandle(:final handle):
        _sessionHandle = handle;
      case GeminiLiveGoAway():
        unawaited(_reconnect('Gemini asked the client to reconnect.'));
      case GeminiLiveError(:final message):
        unawaited(_handleDisconnect(message));
      case GeminiLiveClosed(:final reason):
        unawaited(_handleDisconnect(reason));
    }
  }

  Future<void> _handleDisconnect(String reason) async {
    if (_disposed || state.phase == VoiceCallPhase.ended) return;
    if (isRetryableGeminiDisconnect(reason)) {
      await _reconnect(reason);
      return;
    }
    state = state.copyWith(phase: VoiceCallPhase.failed, error: 'The call was disconnected.');
    await hangUp(reason: 'disconnected');
  }

  Future<void> _reconnect(String reason) async {
    if (_reconnecting || _disposed || state.phase == VoiceCallPhase.ended) return;
    _reconnecting = true;
    // Time already talked is banked, because the wall clock keeps running
    // through a reconnect but the call does not.
    _elapsedBeforeReconnect = _elapsedSeconds();
    _connectedAt = null;
    state = state.copyWith(phase: VoiceCallPhase.reconnecting, characterSpeaking: false);
    await _closeConnection();

    Object? lastError;
    for (var attempt = 0; attempt < _maxAttempts; attempt += 1) {
      if (_disposed || state.phase == VoiceCallPhase.ended) break;
      await Future<void>.delayed(_retryDelayWithJitter(attempt));
      try {
        await _connectOnce();
        _reconnecting = false;
        return;
      } catch (error) {
        lastError = error;
        await _closeConnection();
      }
    }

    _reconnecting = false;
    if (_disposed || state.phase == VoiceCallPhase.ended) return;
    state = state.copyWith(
      phase: VoiceCallPhase.failed,
      error: userFacingError(lastError ?? Exception(reason)),
    );
    await hangUp(reason: 'reconnect_failed');
  }

  void _startTimers() {
    _ticker?.cancel();
    _heartbeatTimer?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
    final session = _session;
    if (session != null) {
      _heartbeatTimer = Timer.periodic(
        Duration(seconds: max(5, session.heartbeatSeconds)),
        (_) => unawaited(_sendHeartbeat()),
      );
    }
  }

  void _tick() {
    // A reconnecting call counts down too. Skipping it left a call that ran out
    // mid-reconnect running until the server's stale-call sweep noticed, with
    // the credit hold out the whole time.
    if (_disposed || !state.isLive) return;
    final elapsed = _elapsedSeconds();
    final remaining = max(0, state.secondsRemaining - 1);
    state = state.copyWith(elapsedSeconds: elapsed, secondsRemaining: remaining);
    if (remaining <= 0) {
      unawaited(
        hangUp(
          reason: state.endingReason == VoiceCallEndingReason.credits
              ? 'out_of_credits'
              : 'time_limit',
        ),
      );
    }
  }

  Future<void> _sendHeartbeat() async {
    final callId = _session?.callId;
    if (callId == null || _disposed || state.phase == VoiceCallPhase.ended) return;
    final batch = _transcriptQueue.take();
    try {
      final meter = await ref
          .read(voiceRepositoryProvider)
          .heartbeat(callId: callId, elapsedSeconds: _elapsedSeconds(), messages: batch);
      if (_disposed) return;
      // Named as soon as the server knows, which is a whole reserve block —
      // minutes — before the clock runs out. Waiting for `secondsRemaining <= 0`
      // meant the caller learned they were out of credits one second before the
      // line went.
      state = state.copyWith(
        secondsRemaining: meter.secondsRemaining,
        chargedCredits: meter.chargedCredits,
        endingReason: meter.endingReason,
        outOfCredits: meter.endingReason == VoiceCallEndingReason.credits,
      );
    } catch (_) {
      // A missed heartbeat is not worth interrupting a call for; the server
      // settles from the last one it did get if they stop entirely. The lines
      // it was carrying go back in the queue — the next beat, or the hang-up,
      // takes them instead.
      _transcriptQueue.restore(batch);
    }
  }

  int _elapsedSeconds() {
    final connectedAt = _connectedAt;
    if (connectedAt == null) return _elapsedBeforeReconnect;
    return _elapsedBeforeReconnect + DateTime.now().difference(connectedAt).inSeconds;
  }

  void _appendCaption(VoiceCallSpeaker speaker, String text, bool finished) {
    if (speaker == VoiceCallSpeaker.caller) {
      _pendingCallerCaption += text;
    } else {
      // They have started replying, so whatever the caller was saying is said.
      // Settling it here rather than waiting for the turn to complete is what
      // puts the caller's line above the reply instead of after it.
      _flushCaption(VoiceCallSpeaker.caller);
      _pendingCharacterCaption += text;
    }
    _publishCaptions();
    if (finished) {
      _flushCaption(speaker);
    }
  }

  void _flushCaption(VoiceCallSpeaker speaker) {
    final pending = speaker == VoiceCallSpeaker.caller
        ? _pendingCallerCaption.trim()
        : _pendingCharacterCaption.trim();
    if (speaker == VoiceCallSpeaker.caller) {
      _pendingCallerCaption = '';
    } else {
      _pendingCharacterCaption = '';
    }
    if (pending.isEmpty) return;
    final line = VoiceCallCaption(speaker: speaker, text: pending);
    // Queued at the same moment it is shown. A line only counts as said once
    // the speaker has finished it, which is exactly what settles a caption.
    _transcriptQueue.add(line);
    state = state.copyWith(
      captions: [...state.captions, line].takeLast(_captionLimit),
    );
    _publishCaptions();
  }

  /// Shows partial lines while they are still being spoken, without committing
  /// them to the transcript — a caption that only appears once the sentence is
  /// finished always reads a beat behind the voice.
  ///
  /// Both speakers can have a line in flight at once, and both are shown. An
  /// earlier version published a single live caption with the character's
  /// winning, which hid the caller's own words for as long as the reply took.
  /// The caller comes first: they spoke first.
  void _publishCaptions() {
    final caller = _pendingCallerCaption.trim();
    final character = _pendingCharacterCaption.trim();
    state = state.copyWith(
      liveCaptions: [
        if (caller.isNotEmpty)
          VoiceCallCaption(speaker: VoiceCallSpeaker.caller, text: caller),
        if (character.isNotEmpty)
          VoiceCallCaption(speaker: VoiceCallSpeaker.character, text: character),
      ],
    );
  }

  Future<void> _closeConnection() async {
    await _micSubscription?.cancel();
    await _socketSubscription?.cancel();
    _micSubscription = null;
    _socketSubscription = null;
    _socket?.close();
    _socket = null;
  }

  Future<void> _teardown() async {
    _ticker?.cancel();
    _heartbeatTimer?.cancel();
    _ticker = null;
    _heartbeatTimer = null;
    await _closeConnection();
    await _audio?.stop();
    _audio = null;
    _connectedAt = null;
  }

  Duration _retryDelayWithJitter(int attempt) {
    final base = _retryDelays[min(attempt, _retryDelays.length - 1)];
    // Spread reconnects out so a flaky network does not sync every client on
    // the same retry tick.
    final jitter = Random().nextInt(base.inMilliseconds ~/ 4 + 1);
    return base + Duration(milliseconds: jitter);
  }
}

class InsufficientCreditsForCallException implements Exception {
  const InsufficientCreditsForCallException(this.message);

  final String message;

  @override
  String toString() => message;
}

class VoiceCallState {
  const VoiceCallState({
    this.character,
    this.phase = VoiceCallPhase.idle,
    this.captions = const [],
    this.liveCaptions = const [],
    this.muted = false,
    this.speakerphone = true,
    this.characterSpeaking = false,
    this.elapsedSeconds = 0,
    this.secondsRemaining = 0,
    this.chargedCredits = 0,
    this.creditsPerMinute = 0,
    this.maxCallSeconds = 0,
    this.outOfCredits = false,
    this.endingReason,
    this.endedBecause,
    this.error,
  });

  final VoiceCharacter? character;
  final VoiceCallPhase phase;
  final List<VoiceCallCaption> captions;
  /// Lines still being spoken, caller first. Rendered after [captions].
  final List<VoiceCallCaption> liveCaptions;
  final bool muted;
  final bool speakerphone;
  final bool characterSpeaking;
  final int elapsedSeconds;
  final int secondsRemaining;
  final int chargedCredits;
  final int creditsPerMinute;
  final int maxCallSeconds;
  final bool outOfCredits;

  /// What is about to end this call, while it is still running.
  final VoiceCallEndingReason? endingReason;

  /// What ended it, once it has. Drives the explanation on the ended screen.
  final VoiceCallEndingReason? endedBecause;

  final String? error;

  bool get isLive =>
      phase == VoiceCallPhase.connected || phase == VoiceCallPhase.reconnecting;

  /// Warn while the call is live and there is something worth warning about.
  ///
  /// A known ending reason warns for its whole runway — minutes, not the last
  /// sixty seconds — because that is the window in which the caller can still
  /// do something about it. Without one, the last minute is enough notice.
  bool get showTimeWarning =>
      isLive && secondsRemaining > 0 && (endingReason != null || secondsRemaining <= 60);

  VoiceCallState copyWith({
    VoiceCharacter? character,
    VoiceCallPhase? phase,
    List<VoiceCallCaption>? captions,
    List<VoiceCallCaption>? liveCaptions,
    bool? muted,
    bool? speakerphone,
    bool? characterSpeaking,
    int? elapsedSeconds,
    int? secondsRemaining,
    int? chargedCredits,
    int? creditsPerMinute,
    int? maxCallSeconds,
    bool? outOfCredits,
    VoiceCallEndingReason? endingReason,
    VoiceCallEndingReason? endedBecause,
    String? error,
  }) {
    return VoiceCallState(
      character: character ?? this.character,
      phase: phase ?? this.phase,
      captions: captions ?? this.captions,
      liveCaptions: liveCaptions ?? this.liveCaptions,
      muted: muted ?? this.muted,
      speakerphone: speakerphone ?? this.speakerphone,
      characterSpeaking: characterSpeaking ?? this.characterSpeaking,
      elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
      secondsRemaining: secondsRemaining ?? this.secondsRemaining,
      chargedCredits: chargedCredits ?? this.chargedCredits,
      creditsPerMinute: creditsPerMinute ?? this.creditsPerMinute,
      maxCallSeconds: maxCallSeconds ?? this.maxCallSeconds,
      outOfCredits: outOfCredits ?? this.outOfCredits,
      endingReason: endingReason ?? this.endingReason,
      endedBecause: endedBecause ?? this.endedBecause,
      error: error,
    );
  }
}

extension _TakeLast<T> on List<T> {
  List<T> takeLast(int count) =>
      length <= count ? this : sublist(length - count);
}

final voiceCallControllerProvider =
    NotifierProvider.autoDispose<VoiceCallController, VoiceCallState>(
      VoiceCallController.new,
    );
