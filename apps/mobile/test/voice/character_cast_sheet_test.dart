import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/presentation/character_network_image.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/features/voice/data/voice_disclosure_store.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/character_cast_sheet.dart';
import 'package:tomeza/shared/api/api_client.dart';

VoiceCharacter character({
  String id = 'character-1',
  String name = 'Marlow',
  String role = 'The lighthouse keeper',
  VoiceCharacterStatus status = VoiceCharacterStatus.ready,
  String? libraryCharacterId,
  String? libraryPortraitUrl,
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
    libraryCharacterId: libraryCharacterId,
    libraryPortraitUrl: libraryPortraitUrl,
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

class MemoryVoiceDisclosureStore implements VoiceDisclosureStore {
  bool acknowledged = false;

  @override
  Future<void> acknowledge() async {
    acknowledged = true;
  }

  @override
  Future<bool> hasAcknowledged() async => acknowledged;
}

Future<void> pumpCastSheet(WidgetTester tester, FakeVoiceRepository repository) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiAuthHeadersProvider.overrideWith(
          (ref) async => const <String, String>{},
        ),
        voiceRepositoryProvider.overrideWithValue(repository),
      ],
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

  testWidgets('toasts the opening hold when a call is tapped without the credits', (
    tester,
  ) async {
    // A disabled row used to swallow the tap, so the cost line was the only
    // explanation and easy to miss. The tap is the attempt; the toast names
    // the number.
    await pumpCastSheet(tester, FakeVoiceRepository(cast(availableCredits: 20)));
    await tester.tap(find.text('Marlow'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.text('You need 180 credits to start a call.'), findsOneWidget);
    expect(find.text('Call a character'), findsNothing);
    expect(find.text('Before your first voice call'), findsNothing);
  });

  testWidgets('lists a callable character with their role', (tester) async {
    await pumpCastSheet(tester, FakeVoiceRepository(cast()));

    expect(find.text('Marlow'), findsOneWidget);
    expect(find.text('The lighthouse keeper'), findsOneWidget);
  });

  testWidgets('discloses microphone and provider processing before the first call', (
    tester,
  ) async {
    final disclosure = MemoryVoiceDisclosureStore();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          voiceRepositoryProvider.overrideWithValue(FakeVoiceRepository(cast())),
          voiceDisclosureStoreProvider.overrideWithValue(disclosure),
        ],
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
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
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Marlow'));
    await tester.pumpAndSettle();

    expect(find.text('Before your first voice call'), findsOneWidget);
    expect(find.textContaining('sent in real time'), findsOneWidget);
    expect(find.textContaining('does not retain live-call audio'), findsOneWidget);
    expect(disclosure.acknowledged, isFalse);

    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(disclosure.acknowledged, isFalse);
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

  testWidgets('says which cast member is the reader\'s own saved character', (
    tester,
  ) async {
    // Two rows, one linked: the badge has to name the link rather than the
    // sheet saying it somewhere general, because the whole question is which
    // of these is the character the reader saved.
    await pumpCastSheet(
      tester,
      FakeVoiceRepository(
        cast(
          characters: [
            character(
              libraryCharacterId: 'lib-1',
              libraryPortraitUrl: '/api/mobile/characters/lib-1/portrait',
            ),
            character(id: 'character-2', name: 'Invented', role: 'A stranger'),
          ],
        ),
      ),
    );

    expect(find.text('From your characters'), findsOneWidget);
    expect(find.text('Marlow'), findsOneWidget);
    expect(find.text('Invented'), findsOneWidget);
    // The linked row draws the saved portrait through the character asset
    // route (its own bearer headers), not the project one — the unlinked row
    // still has nothing to draw.
    expect(find.byType(CharacterNetworkImage), findsOneWidget);
  });

  testWidgets('a cast member the book invented carries no library badge', (
    tester,
  ) async {
    await pumpCastSheet(tester, FakeVoiceRepository(cast()));

    expect(find.text('From your characters'), findsNothing);
  });

  testWidgets('reads the library link off the wire', (tester) async {
    final parsed = VoiceCharacter.fromJson(const {
      'id': 'character-1',
      'projectId': 'project-1',
      'name': 'Natalia',
      'libraryCharacterId': 'lib-1',
      'libraryPortraitUrl': '/api/mobile/characters/lib-1/portrait',
    });

    expect(parsed.fromLibrary, isTrue);
    // No cast image yet, so the saved portrait is what the avatar draws — the
    // window where a linked row used to render grey initials despite the app
    // holding the picture.
    expect(parsed.standInPortraitUrl, '/api/mobile/characters/lib-1/portrait');

    final built = VoiceCharacter.fromJson(const {
      'id': 'character-1',
      'projectId': 'project-1',
      'name': 'Natalia',
      'libraryCharacterId': 'lib-1',
      'libraryPortraitUrl': '/api/mobile/characters/lib-1/portrait',
      'image': {
        'id': 'image-1',
        'role': 'character',
        'url': '/assets/images/project-1/character-1.png',
        'contentType': 'image/png',
        'altText': 'Natalia',
      },
    });

    // Once the book has drawn her, that likeness wins: it is this book's own
    // reference sheet, not an account-level portrait.
    expect(built.standInPortraitUrl, isNull);

    final invented = VoiceCharacter.fromJson(const {
      'id': 'character-2',
      'projectId': 'project-1',
      'name': 'Someone',
    });
    expect(invented.fromLibrary, isFalse);
    expect(invented.standInPortraitUrl, isNull);
  });
}
