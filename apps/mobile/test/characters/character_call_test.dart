import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/characters/presentation/character_call.dart';
import 'package:tomeza/features/characters/presentation/character_profile_screen.dart';
import 'package:tomeza/features/voice/data/voice_call_audio.dart';
import 'package:tomeza/features/voice/data/voice_call_recorder.dart';
import 'package:tomeza/features/voice/data/voice_disclosure_store.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:tomeza/features/voice/presentation/voice_call_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'character_test_support.dart';

/// Calling a saved character from their own page.
///
/// The call itself is the book's call — screen, meter, memory — so what these
/// pin is the way in: the button on the profile, the balance gate, and the
/// character the call screen is handed.
void main() {
  VoiceCharacter mina({String? portraitUrl}) => VoiceCharacter(
    id: 'char-1',
    name: 'Mina Park',
    role: '',
    description: 'Brave, curious, always muddy.',
    traits: const [],
    status: VoiceCharacterStatus.ready,
    needsPreparation: false,
    libraryCharacterId: 'char-1',
    libraryPortraitUrl: portraitUrl,
  );

  VoiceCast cast({List<VoiceCharacter>? characters, int availableCredits = 600}) =>
      VoiceCast(
        characters: characters ?? [mina()],
        creditsPerMinute: 60,
        creditsToStart: 180,
        availableCredits: availableCredits,
        maxCallSeconds: 1800,
      );

  Future<_FakeVoiceRepository> pumpProfile(
    WidgetTester tester, {
    required VoiceCast cast,
    bool disclosed = true,
  }) async {
    final voice = _FakeVoiceRepository(cast);
    final controller = _StubVoiceCallController();
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiAuthHeadersProvider.overrideWith(
            (ref) async => const <String, String>{},
          ),
          charactersRepositoryProvider.overrideWithValue(
            FakeCharactersRepository(testCharacter(hasPhoto: false)),
          ),
          voiceRepositoryProvider.overrideWithValue(voice),
          voiceDisclosureStoreProvider.overrideWithValue(
            _MemoryDisclosureStore(acknowledged: disclosed),
          ),
          voiceCallControllerProvider.overrideWith(() => controller),
        ],
        child: const MaterialApp(
          home: CharacterProfileScreen(characterId: 'char-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return voice;
  }

  testWidgets('the profile offers a call, and it opens the call screen for this character', (
    tester,
  ) async {
    final voice = await pumpProfile(
      tester,
      cast: cast(characters: [mina(portraitUrl: '/api/mobile/characters/char-1/images/img-1')]),
    );

    await tester.tap(find.byKey(const ValueKey('character-profile-call')));
    await tester.pumpAndSettle();

    expect(find.byType(VoiceCallScreen), findsOneWidget);
    final screen = tester.widget<VoiceCallScreen>(find.byType(VoiceCallScreen));
    // A library call: no book, and the server's own entry for the character,
    // picture included.
    expect(screen.projectId, isNull);
    expect(screen.character.id, 'char-1');
    expect(screen.character.libraryPortraitUrl, '/api/mobile/characters/char-1/images/img-1');
    // Read fresh on the tap, from the library rather than from any book.
    expect(voice.castRequests, [null]);
  });

  testWidgets('names the credits a call needs when the balance cannot cover it', (
    tester,
  ) async {
    await pumpProfile(tester, cast: cast(availableCredits: 20));

    await tester.tap(find.byKey(const ValueKey('character-profile-call')));
    await tester.pumpAndSettle();

    expect(find.byType(VoiceCallScreen), findsNothing);
    expect(find.text('You need 180 credits to start a call.'), findsOneWidget);
  });

  testWidgets('shows the microphone disclosure before the first call, wherever it is placed', (
    tester,
  ) async {
    await pumpProfile(tester, cast: cast(), disclosed: false);

    await tester.tap(find.byKey(const ValueKey('character-profile-call')));
    await tester.pumpAndSettle();

    expect(find.text('Before your first voice call'), findsOneWidget);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceCallScreen), findsNothing);
  });

  test('a character the cast has not caught up with is still callable', () {
    final built = voiceCharacterFor(
      testCharacter(id: 'char-9', name: 'Sol'),
      cast(),
    );

    expect(built.id, 'char-9');
    expect(built.projectId, isNull);
    expect(built.libraryCharacterId, 'char-9');
    expect(built.status, VoiceCharacterStatus.ready);
  });
}

class _FakeVoiceRepository implements VoiceRepository {
  _FakeVoiceRepository(this._cast);

  final VoiceCast _cast;
  final castRequests = <String?>[];

  @override
  Future<VoiceCast> getCast(String? projectId) async {
    castRequests.add(projectId);
    return _cast;
  }

  @override
  Future<VoiceCallSession> startCall({
    required String? projectId,
    required String characterId,
    int? pageIndex,
  }) => throw UnimplementedError();

  @override
  Future<VoiceCallMeter> heartbeat({
    required String callId,
    required int elapsedSeconds,
    List<VoiceCallCaption> messages = const [],
  }) => throw UnimplementedError();

  @override
  Future<VoiceCallMeter> endCall({
    required String callId,
    required int elapsedSeconds,
    String reason = 'ended',
    List<VoiceCallCaption> messages = const [],
  }) => throw UnimplementedError();
}

class _MemoryDisclosureStore implements VoiceDisclosureStore {
  _MemoryDisclosureStore({required this.acknowledged});

  bool acknowledged;

  @override
  Future<void> acknowledge() async => acknowledged = true;

  @override
  Future<bool> hasAcknowledged() async => acknowledged;
}

/// Never dials: the screen under test is the profile, and the call screen
/// only has to be reached, not connected.
class _StubVoiceCallController extends VoiceCallController {
  @override
  VoiceCallState build() => const VoiceCallState();

  @override
  Future<void> dial({
    required String? projectId,
    required VoiceCharacter character,
    int? pageIndex,
    VoiceCallAudio? audio,
    VoiceCallRecorder? recorder,
    GeminiLiveSocketConnector? socketConnector,
  }) async {
    state = VoiceCallState(character: character, phase: VoiceCallPhase.ringing);
  }

  @override
  Future<File?> exportRecording() async => null;

  @override
  Future<void> hangUp({String reason = 'ended'}) async {}
}
