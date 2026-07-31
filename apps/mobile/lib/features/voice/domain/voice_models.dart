import '../../projects/domain/project_models.dart';

/// Whether a character can take a call right now.
///
/// `preparing` resolves on its own — the server is building the persona and the
/// cast sheet polls until it flips to `ready`.
enum VoiceCharacterStatus { ready, preparing, unavailable }

VoiceCharacterStatus voiceCharacterStatusFrom(String? value) {
  return switch (value) {
    'ready' => VoiceCharacterStatus.ready,
    'preparing' => VoiceCharacterStatus.preparing,
    _ => VoiceCharacterStatus.unavailable,
  };
}

class VoiceCharacter {
  const VoiceCharacter({
    required this.id,
    required this.projectId,
    required this.name,
    required this.role,
    required this.description,
    required this.traits,
    required this.status,
    required this.needsPreparation,
    this.image,
  });

  factory VoiceCharacter.fromJson(Map<String, dynamic> json) {
    final image = json['image'];
    return VoiceCharacter(
      id: json['id'] as String,
      projectId: json['projectId'] as String? ?? '',
      name: json['name'] as String? ?? 'Character',
      role: json['role'] as String? ?? '',
      description: json['description'] as String? ?? '',
      traits: (json['traits'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(growable: false),
      status: voiceCharacterStatusFrom(json['status'] as String?),
      needsPreparation: json['needsPreparation'] as bool? ?? false,
      image: image is Map<String, dynamic>
          ? MobileProjectImage.fromJson(image)
          : null,
    );
  }

  final String id;
  final String projectId;
  final String name;
  final String role;
  final String description;
  final List<String> traits;
  final VoiceCharacterStatus status;
  final bool needsPreparation;
  final MobileProjectImage? image;

  bool get callable => status != VoiceCharacterStatus.unavailable;
}

class VoiceCast {
  const VoiceCast({
    required this.characters,
    required this.creditsPerMinute,
    required this.creditsToStart,
    required this.availableCredits,
    required this.maxCallSeconds,
  });

  factory VoiceCast.fromJson(Map<String, dynamic> json) {
    return VoiceCast(
      characters: (json['characters'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(VoiceCharacter.fromJson)
          .toList(growable: false),
      creditsPerMinute: json['creditsPerMinute'] as int? ?? 0,
      creditsToStart: json['creditsToStart'] as int? ?? 0,
      availableCredits: json['availableCredits'] as int? ?? 0,
      maxCallSeconds: json['maxCallSeconds'] as int? ?? 0,
    );
  }

  static const empty = VoiceCast(
    characters: [],
    creditsPerMinute: 0,
    creditsToStart: 0,
    availableCredits: 0,
    maxCallSeconds: 0,
  );

  final List<VoiceCharacter> characters;
  final int creditsPerMinute;
  final int creditsToStart;
  final int availableCredits;
  final int maxCallSeconds;

  bool get isEmpty => characters.isEmpty;

  bool get canAfford => availableCredits >= creditsToStart;

  /// Minutes the current balance pays for, floored — what the cast sheet
  /// promises has to be time the user definitely has.
  int get affordableMinutes =>
      creditsPerMinute <= 0 ? 0 : availableCredits ~/ creditsPerMinute;
}

/// Everything needed to open a Gemini Live socket for one call.
class VoiceCallSession {
  const VoiceCallSession({
    required this.callId,
    required this.characterId,
    required this.characterName,
    required this.token,
    required this.model,
    required this.inputSampleRate,
    required this.outputSampleRate,
    required this.secondsRemaining,
    required this.creditsPerMinute,
    required this.heartbeatSeconds,
    required this.maxCallSeconds,
  });

  factory VoiceCallSession.fromJson(Map<String, dynamic> json) {
    return VoiceCallSession(
      callId: json['callId'] as String,
      characterId: json['characterId'] as String? ?? '',
      characterName: json['characterName'] as String? ?? 'Character',
      token: json['token'] as String,
      model: json['model'] as String,
      inputSampleRate: json['inputSampleRate'] as int? ?? 16000,
      outputSampleRate: json['outputSampleRate'] as int? ?? 24000,
      secondsRemaining: json['secondsRemaining'] as int? ?? 0,
      creditsPerMinute: json['creditsPerMinute'] as int? ?? 0,
      heartbeatSeconds: json['heartbeatSeconds'] as int? ?? 20,
      maxCallSeconds: json['maxCallSeconds'] as int? ?? 1800,
    );
  }

  final String callId;
  final String characterId;
  final String characterName;
  final String token;
  final String model;
  final int inputSampleRate;
  final int outputSampleRate;
  final int secondsRemaining;
  final int creditsPerMinute;
  final int heartbeatSeconds;
  final int maxCallSeconds;
}

/// What is about to end a call, while there is still time to say so.
///
/// The two need different words: running dry is fixed by buying credits, and
/// reaching the length cap is not.
enum VoiceCallEndingReason { credits, limit }

VoiceCallEndingReason? voiceCallEndingReasonFrom(String? value) {
  return switch (value) {
    'credits' => VoiceCallEndingReason.credits,
    'limit' => VoiceCallEndingReason.limit,
    _ => null,
  };
}

class VoiceCallMeter {
  const VoiceCallMeter({
    required this.elapsedSeconds,
    required this.secondsRemaining,
    required this.chargedCredits,
    required this.endingSoon,
    this.endingReason,
  });

  factory VoiceCallMeter.fromJson(Map<String, dynamic> json) {
    return VoiceCallMeter(
      elapsedSeconds: json['elapsedSeconds'] as int? ?? 0,
      secondsRemaining: json['secondsRemaining'] as int? ?? 0,
      chargedCredits: json['chargedCredits'] as int? ?? 0,
      endingSoon: json['endingSoon'] as bool? ?? false,
      endingReason: voiceCallEndingReasonFrom(json['endingReason'] as String?),
    );
  }

  final int elapsedSeconds;
  final int secondsRemaining;
  final int chargedCredits;
  final bool endingSoon;
  final VoiceCallEndingReason? endingReason;
}

/// Where a call is, from the caller's point of view.
///
/// `preparing` is the first-call persona build; `ringing` is the socket
/// handshake. They are separate states because they need different words —
/// "Waking Marlow up" reads very differently from "Connecting".
enum VoiceCallPhase { idle, preparing, ringing, connected, reconnecting, ended, failed }

/// One line of the live transcript.
class VoiceCallCaption {
  const VoiceCallCaption({required this.speaker, required this.text});

  final VoiceCallSpeaker speaker;
  final String text;

  VoiceCallCaption copyWith({String? text}) =>
      VoiceCallCaption(speaker: speaker, text: text ?? this.text);

  /// How a finished line is reported to the server, where it becomes what the
  /// character remembers of this call the next time the reader rings.
  Map<String, dynamic> toJson() => {
    'speaker': speaker == VoiceCallSpeaker.caller ? 'caller' : 'character',
    'text': text,
  };
}

enum VoiceCallSpeaker { caller, character }
