import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/character_cast_sheet.dart';

VoiceCharacter character({
  String id = 'character-1',
  String name = 'Marlow',
  String role = 'The lighthouse keeper',
  VoiceCharacterStatus status = VoiceCharacterStatus.ready,
}) {
  return VoiceCharacter(
    id: id,
    projectId: 'project-1',
    name: name,
    role: role,
    description: 'Keeps the light.',
    traits: const [],
    status: status,
    needsPreparation: false,
  );
}

VoiceCast cast({
  List<VoiceCharacter>? characters,
  int availableCredits = 600,
}) {
  return VoiceCast(
    characters: characters ?? [character()],
    creditsPerMinute: 60,
    creditsToStart: 180,
    availableCredits: availableCredits,
    maxCallSeconds: 1800,
  );
}

class FakeVoiceRepository implements VoiceRepository {
  FakeVoiceRepository(this._cast);

  final VoiceCast _cast;
  int castCalls = 0;

  @override
  Future<VoiceCast> getCast(String projectId) async {
    castCalls += 1;
    return _cast;
  }

  @override
  Future<VoiceCallSession> startCall({
    required String projectId,
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

Future<void> pumpCastSheet(WidgetTester tester, FakeVoiceRepository repository) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [voiceRepositoryProvider.overrideWithValue(repository)],
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showCharacterCastSheet(
                  context: context,
                  projectId: 'project-1',
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows what a call costs in minutes the balance actually covers', (tester) async {
    // 600 credits at 60 a minute is ten minutes, floored so the number is a
    // promise rather than an estimate.
    await pumpCastSheet(tester, FakeVoiceRepository(cast(availableCredits: 640)));

    expect(find.text('Call a character'), findsOneWidget);
    expect(find.textContaining('60 credits a minute'), findsOneWidget);
    expect(find.textContaining('about 10 minutes'), findsOneWidget);
  });

  testWidgets('tells a user who cannot afford a call what they need', (tester) async {
    await pumpCastSheet(tester, FakeVoiceRepository(cast(availableCredits: 20)));

    expect(find.text('You need 180 credits to start a call.'), findsOneWidget);
  });

  testWidgets('lists a callable character with their role', (tester) async {
    await pumpCastSheet(tester, FakeVoiceRepository(cast()));

    expect(find.text('Marlow'), findsOneWidget);
    expect(find.text('The lighthouse keeper'), findsOneWidget);
  });

  testWidgets('says a character is being prepared rather than hiding them', (tester) async {
    await pumpCastSheet(
      tester,
      FakeVoiceRepository(
        cast(characters: [character(status: VoiceCharacterStatus.preparing)]),
      ),
    );

    expect(find.text('Marlow'), findsOneWidget);
    expect(find.text('Getting ready to talk…'), findsOneWidget);
  });

  testWidgets('polls while a character is still being prepared', (tester) async {
    final repository = FakeVoiceRepository(
      cast(characters: [character(status: VoiceCharacterStatus.preparing)]),
    );
    await pumpCastSheet(tester, repository);

    expect(repository.castCalls, 1);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(repository.castCalls, greaterThan(1));

    // Close the sheet so the timer is cancelled before the test ends.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
  });

  testWidgets('explains an empty cast instead of showing a blank sheet', (tester) async {
    await pumpCastSheet(tester, FakeVoiceRepository(cast(characters: [])));

    expect(find.text('No one to call yet'), findsOneWidget);
  });
}
