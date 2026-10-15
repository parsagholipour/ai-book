import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/data/audiobook_progress_store.dart';
import 'package:tomeza/features/audiobook/data/audiobook_repository.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_player.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_plan_offer.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

import '../billing/billing_paywall_harness.dart' as harness;
import 'audiobook_fakes.dart';

/// Narrating a book is a plan perk; listening to one that exists is not. A
/// free reader is shown what narration would be, with a lock, and the button
/// opens the plans instead of the narrator picker whose confirm the server
/// would refuse.
void main() {
  late Directory tempDir;
  late FakeAudiobookRepository repository;
  ProviderContainer? active;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-audiobook-plan');
    repository = FakeAudiobookRepository(audiobook: null);
  });

  tearDown(() {
    active?.dispose();
    active = null;
    tempDir.deleteSync(recursive: true);
  });

  Future<void> pumpScreen(WidgetTester tester, {String? planTier}) async {
    final container = ProviderContainer(
      overrides: [
        audiobookRepositoryProvider.overrideWithValue(repository),
        audiobookCacheProvider.overrideWithValue(FakeAudiobookCache(tempDir)),
        audiobookProgressStoreProvider.overrideWithValue(
          FakeAudiobookProgressStore(),
        ),
        audiobookPlayerFactoryProvider.overrideWithValue(
          FakeAudiobookPlayer.new,
        ),
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
    );
    active = container;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: AudiobookScreen(projectId: 'project-1')),
      ),
    );
    await settle(tester);
  }

  test('only a known free account is locked', () {
    expect(audiobooksLockedByPlan(null), isFalse);
    expect(
      audiobooksLockedByPlan(harness.fakeBilling(availableCredits: 100)),
      isTrue,
    );
    expect(
      audiobooksLockedByPlan(
        harness.fakeBilling(availableCredits: 100, planTier: 'pro'),
      ),
      isFalse,
    );
  });

  testWidgets('a free reader sees narration as a plan perk', (tester) async {
    await pumpScreen(tester);

    expect(find.text('Hear your book read aloud'), findsOneWidget);
    expect(find.byKey(const ValueKey('audiobook-plan-locked')), findsOneWidget);
    expect(find.text('See plans'), findsOneWidget);
    expect(find.text('Choose a narrator'), findsNothing);

    await tester.ensureVisible(find.text('See plans'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('See plans'));
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsOneWidget);
    // The plans, not the narrator picker, and nothing was started.
    expect(find.text('Start narrating'), findsNothing);
    expect(repository.starts, isEmpty);
    active?.dispose();
    active = null;
  });

  testWidgets('a reader on a plan chooses a narrator as before', (
    tester,
  ) async {
    await pumpScreen(tester, planTier: 'creator');

    expect(find.byKey(const ValueKey('audiobook-plan-locked')), findsNothing);
    expect(find.text('Choose a narrator'), findsOneWidget);
    active?.dispose();
    active = null;
  });
}
