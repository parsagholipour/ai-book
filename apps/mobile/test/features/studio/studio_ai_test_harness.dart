import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/studio/data/studio_local_drafts.dart';
import 'package:tomeza/features/studio/presentation/studio_ai_billing.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

/// Stands in for the billing sheets (the paywall needs the store): records
/// which one the Studio asked for and answers as told.
class FakeStudioBillingGate implements StudioAiBillingGate {
  FakeStudioBillingGate({this.messagesAvailable = true, this.recovers = false});

  /// What the pre-send allowance check answers.
  bool messagesAvailable;

  /// Whether the author comes back from a billing sheet able to go on.
  bool recovers;

  final List<String> calls = [];

  @override
  Future<bool> ensureMessages(BuildContext context, WidgetRef ref) async {
    calls.add('ensureMessages');
    return messagesAvailable;
  }

  @override
  Future<bool> messageLimitReached(BuildContext context, WidgetRef ref) async {
    calls.add('messageLimitReached');
    return recovers;
  }

  @override
  Future<bool> creditsNeeded(
    BuildContext context,
    WidgetRef ref,
    ApiException error, {
    required String projectId,
    required String reason,
  }) async {
    calls.add('creditsNeeded');
    return recovers;
  }

  @override
  Future<bool> planRequired(
    BuildContext context,
    WidgetRef ref,
    ApiException error, {
    required String projectId,
  }) async {
    calls.add('planRequired:${error.code}');
    return recovers;
  }
}

/// A price table with its own image rate, so a quote that reads it shows.
MobileBilling studioAiBilling({
  Map<String, dynamic> creditCosts = const {'imageGeneration': 50},
}) {
  return MobileBilling(
    credits: const CreditBalance(
      available: 2000,
      reserved: 0,
      lifetimeGranted: 2000,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: creditCosts,
  );
}

/// [studioTestApp] with the writing assistant's billing seams stood in: the
/// price table, the book's tier, and the billing sheets.
Widget studioAiTestApp({
  required FakeStudioRepository repo,
  FakeStudioBillingGate? gate,
  MobileBilling? billing,
  String quality = 'balanced',
  MemoryStudioLocalDrafts? drafts,
  String? chapterId,
  Brightness brightness = Brightness.light,
}) {
  return ProviderScope(
    overrides: [
      billingProvider.overrideWith((ref) async => billing ?? studioAiBilling()),
      studioQualityPresetProvider.overrideWith((ref, _) async => quality),
      studioAiBillingGateProvider.overrideWithValue(
        gate ?? FakeStudioBillingGate(),
      ),
    ],
    child: studioTestApp(
      repo: repo,
      drafts: drafts,
      chapterId: chapterId,
      brightness: brightness,
    ),
  );
}

/// Opens the Studio for [repo] and lets it load.
Future<void> openStudioAi(
  WidgetTester tester,
  FakeStudioRepository repo, {
  FakeStudioBillingGate? gate,
  MobileBilling? billing,
  String? chapterId,
  Size size = const Size(390, 844),
}) async {
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    studioAiTestApp(
      repo: repo,
      gate: gate,
      billing: billing,
      chapterId: chapterId,
    ),
  );
  await settle(tester);
}

/// Focuses body field [index] and selects [start]..[end] in it (a cursor
/// when [end] is null).
Future<void> selectInBody(
  WidgetTester tester, {
  int index = 0,
  required int start,
  int? end,
}) async {
  final field = bodyFields().at(index);
  final editable = tester.widget<EditableText>(field);
  editable.focusNode.requestFocus();
  await tester.pump();
  editable.controller.selection = TextSelection(
    baseOffset: start,
    extentOffset: end ?? start,
  );
  await tester.pump();
}

/// The text of body field [index].
String bodyText(WidgetTester tester, [int index = 0]) =>
    tester.widget<EditableText>(bodyFields().at(index)).controller.text;
