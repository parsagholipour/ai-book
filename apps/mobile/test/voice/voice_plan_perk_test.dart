import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/voice/data/voice_call_audio.dart';
import 'package:tomeza/features/voice/data/voice_disclosure_store.dart';
import 'package:tomeza/features/voice/data/voice_repository.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/presentation/character_cast_sheet.dart';
import 'package:tomeza/features/voice/presentation/voice_call_controller.dart';
import 'package:tomeza/features/voice/presentation/voice_call_launcher.dart';
import 'package:tomeza/features/voice/presentation/voice_call_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../billing/billing_paywall_harness.dart' as harness;
import 'character_cast_sheet_test.dart'
    show FakeVoiceRepository, MemoryVoiceDisclosureStore, cast, character;

/// Voice calls are a plan perk. A free reader still sees the cast — each call
/// button wearing a lock — and a tap opens the plans instead of a call; a call
/// the server refuses for want of a plan (stale billing, or this check skipped)
/// ends on the plans rather than on "Call again".
Future<MemoryVoiceDisclosureStore> _pumpCast(
  WidgetTester tester, {
  String? planTier,
}) async {
  final disclosure = MemoryVoiceDisclosureStore();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        voiceRepositoryProvider.overrideWithValue(FakeVoiceRepository(cast())),
        voiceDisclosureStoreProvider.overrideWithValue(disclosure),
        billingRepositoryProvider.overrideWithValue(
          harness.FakeBillingRepository(planTier: planTier),
        ),
        storeBillingClientProvider.overrideWithValue(
          harness.FakeStoreBillingClient(),
        ),
        creditLogRepositoryProvider.overrideWithValue(
          harness.EmptyCreditLogRepository(),
        ),
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
  return disclosure;
}

/// Refuses every start the way the server does for a free account.
class _PlanRefusingRepository implements VoiceRepository {
  int startCalls = 0;

  @override
  Future<VoiceCast> getCast(String? projectId) async => cast();

  @override
  Future<VoiceCallSession> startCall({
    required String? projectId,
    required String characterId,
    int? pageIndex,
  }) async {
    startCalls += 1;
    throw const ApiException(
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Voice calls are part of the Creator plan.',
      statusCode: 403,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not used in this test.');
}

class _SilentAudio implements VoiceCallAudio {
  @override
  Future<bool> ensurePermission() async => true;

  @override
  Future<Stream<Uint8List>> start({
    required int inputSampleRate,
    required int outputSampleRate,
    required bool speakerphone,
  }) async => const Stream.empty();

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

class _FixedCall extends VoiceCallController {
  _FixedCall(this._initial);

  final VoiceCallState _initial;

  @override
  VoiceCallState build() => _initial;

  @override
  Future<void> dial({
    required String? projectId,
    required VoiceCharacter character,
    int? pageIndex,
    VoiceCallAudio? audio,
    Object? recorder,
    GeminiLiveSocketConnector? socketConnector,
  }) async {}

  @override
  Future<void> hangUp({String reason = 'ended'}) async {}
}

void main() {
  test('only a known free account is locked', () {
    expect(voiceCallsLockedByPlan(null), isFalse);
    expect(
      voiceCallsLockedByPlan(harness.fakeBilling(availableCredits: 100)),
      isTrue,
    );
    expect(
      voiceCallsLockedByPlan(
        harness.fakeBilling(availableCredits: 100, planTier: 'creator'),
      ),
      isFalse,
    );
  });

  testWidgets('a free reader sees the cast locked and a tap opens the plans', (
    tester,
  ) async {
    await _pumpCast(tester);

    expect(
      find.textContaining('Voice calls are part of the Creator plan.'),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('voice-cast-call-locked')),
      findsOneWidget,
    );

    await tester.tap(find.text('Marlow'));
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(find.text('Talk to your characters'), findsOneWidget);
    // No call was placed: the disclosure that precedes every first call never
    // showed, and the cast is still underneath the plans.
    expect(find.text('Before your first voice call'), findsNothing);
  });

  testWidgets('a reader on a plan rings as before', (tester) async {
    await _pumpCast(tester, planTier: 'creator');

    expect(find.byKey(const ValueKey('voice-cast-call-locked')), findsNothing);
    expect(find.textContaining('credits a minute'), findsOneWidget);

    await tester.tap(find.text('Marlow'));
    await tester.pumpAndSettle();
    expect(find.byType(BillingPaywall), findsNothing);
    expect(find.text('Before your first voice call'), findsOneWidget);
  });

  testWidgets('a start refused for want of a plan ends on the plans', (
    tester,
  ) async {
    final repository = _PlanRefusingRepository();
    final container = ProviderContainer(
      overrides: [voiceRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      voiceCallControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);

    await container
        .read(voiceCallControllerProvider.notifier)
        .dial(
          projectId: 'project-1',
          character: character(),
          audio: _SilentAudio(),
        );

    final state = container.read(voiceCallControllerProvider);
    expect(repository.startCalls, 1);
    expect(state.phase, VoiceCallPhase.failed);
    expect(state.planRequired, isTrue);
    expect(state.outOfCredits, isFalse);
    expect(state.error, 'Voice calls are part of the Creator plan.');
  });

  testWidgets('the ended screen offers the plans, not a ring-again', (
    tester,
  ) async {
    final marlow = character();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          voiceCallControllerProvider.overrideWith(
            () => _FixedCall(
              VoiceCallState(
                character: marlow,
                phase: VoiceCallPhase.failed,
                planRequired: true,
                error: 'Voice calls are part of the Creator plan.',
              ),
            ),
          ),
        ],
        child: MaterialApp(
          home: VoiceCallScreen(projectId: 'project-1', character: marlow),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const ValueKey('voice-call-see-plans')), findsOneWidget);
    expect(find.text('Call again'), findsNothing);
    expect(find.text('Add credits'), findsNothing);
  });
}
