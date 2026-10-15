import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/account/presentation/account_overview_card.dart';
import 'package:tomeza/features/auth/presentation/verify_email_location.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/data/message_allowance_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/domain/message_allowance.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/message_allowance_banner.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/plan_approval.dart';

import 'billing_paywall_harness.dart';

/// Welcome credits wait for a verified email, and a free reader's first chat
/// message costs a credit — so an email sign-up who skipped the code met the
/// credit paywall with 1,250 free credits unclaimed (launch review C5). Every
/// surface that asks for credits now leads with the free way out, and keeps
/// the paid ones beneath it.
void main() {
  const lead = 'Verify your email to get your 1,250 free credits.';
  final leadKey = find.byKey(const ValueKey('verify-email-credits-lead'));

  MobileBilling billing({
    required bool awaiting,
    int available = 0,
    MessageAllowance? messages,
  }) {
    final base = fakeBilling(availableCredits: available);
    return MobileBilling(
      purchaseAccountId: base.purchaseAccountId,
      credits: base.credits,
      entitlements: base.entitlements,
      products: base.products,
      creditCosts: base.creditCosts,
      messageAllowance: messages,
      welcomeCreditsPending: awaiting,
      welcomeCreditsPendingReason: awaiting ? 'email_unverified' : null,
      welcomeCreditsPendingCredits: awaiting ? 1250 : null,
    );
  }

  /// A page under a real router with the verify screen one route away, so a
  /// tap on Verify is seen to close the sheet and arrive there.
  Widget app(
    MobileBilling value,
    Widget Function(BuildContext context, WidgetRef ref) home, {
    List<Override> overrides = const [],
  }) {
    final repository = FakeBillingRepository()..billing = value;
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => Scaffold(
            body: Center(
              child: Consumer(builder: (context, ref, _) => home(context, ref)),
            ),
          ),
        ),
        GoRoute(
          path: verifyEmailPath,
          builder: (context, state) =>
              const Scaffold(body: Text('Verify screen')),
        ),
      ],
    );
    return ProviderScope(
      overrides: [
        storeBillingClientProvider.overrideWithValue(FakeStoreBillingClient()),
        billingRepositoryProvider.overrideWithValue(repository),
        creditLogRepositoryProvider.overrideWithValue(
          EmptyCreditLogRepository(),
        ),
        ...overrides,
      ],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        routerConfig: router,
      ),
    );
  }

  Widget opener(String label, Future<void> Function() open) =>
      FilledButton(onPressed: open, child: Text(label));

  Future<void> tapVerify(WidgetTester tester) async {
    final button = find.descendant(
      of: leadKey,
      matching: find.text('Verify email'),
    );
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
  }

  group('the credits paywall', () {
    Widget shortfall(MobileBilling value) => app(
      value,
      (context, ref) => opener(
        'Send',
        () => showBillingPaywall(
          context,
          title: null,
          creditsNeeded: const PaywallCreditsNeeded(
            credits: 1,
            reason: 'Sending this message.',
          ),
        ),
      ),
    );

    testWidgets('leads a shortfall with Verify, keeps the packs, and closes '
        'itself on the way to the code', (tester) async {
      // Tall enough that the lazy list builds the switch under the lead.
      tester.view.physicalSize = const Size(800, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(shortfall(billing(awaiting: true)));
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();

      expect(find.text(lead), findsOneWidget);
      // Before any price: above the plans-or-packs switch.
      expect(
        tester.getTopLeft(leadKey).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('paywall-buy-credits')))
              .dy,
        ),
      );
      // Buying is still there, beneath it.
      final pack = find.byKey(
        const ValueKey('paywall-topup-tomeza.credit_pack_1'),
      );
      await tester.scrollUntilVisible(
        pack,
        200,
        scrollable: find
            .descendant(
              of: find.byType(DraggableScrollableSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(pack, findsOneWidget);

      await tapVerify(tester);

      expect(find.text('Verify screen'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('paywall-credits-needed')),
        findsNothing,
      );
    });

    testWidgets('a shortfall with nothing waiting on the email is the paywall '
        'it always was', (tester) async {
      await tester.pumpWidget(shortfall(billing(awaiting: false)));
      await tester.tap(find.text('Send'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('paywall-credits-needed')),
        findsOneWidget,
      );
      expect(leadKey, findsNothing);
      expect(find.textContaining('free credits'), findsNothing);
    });

    testWidgets('browsing plans is not nagged, but the one-time credits are '
        'led by Verify', (tester) async {
      await tester.pumpWidget(
        app(
          billing(awaiting: true),
          (context, ref) =>
              opener('Upgrade', () => showBillingPaywall(context)),
        ),
      );
      await tester.tap(find.text('Upgrade'));
      await tester.pumpAndSettle();
      expect(leadKey, findsNothing);

      await tester.tap(find.byKey(const ValueKey('paywall-buy-credits')));
      await tester.pumpAndSettle();
      expect(find.text(lead), findsOneWidget);
    });
  });

  group('plan approval short of credits', () {
    Widget approval(MobileBilling value) => app(
      value,
      (context, ref) => opener(
        'Approve',
        () => confirmAndApprovePlan(context, ref, _plannedBook()),
      ),
    );

    testWidgets('leads with Verify, and the book\'s price is still there', (
      tester,
    ) async {
      await tester.pumpWidget(approval(billing(awaiting: true)));
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('paywall-credits-needed')),
        findsOneWidget,
      );
      expect(find.text(lead), findsOneWidget);
      expect(find.text('Approve this plan?'), findsNothing);

      await tapVerify(tester);
      expect(find.text('Verify screen'), findsOneWidget);
    });

    testWidgets('without a waiting grant it is the plain shortfall', (
      tester,
    ) async {
      await tester.pumpWidget(approval(billing(awaiting: false)));
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('paywall-credits-needed')),
        findsOneWidget,
      );
      expect(leadKey, findsNothing);
    });
  });

  group('the message allowance sheet', () {
    final perMessage = MessageAllowance(
      used: 0,
      limit: 50,
      remaining: 50,
      creditsPerMessage: 1,
      resetEnabled: true,
      resetCredits: 50,
      resetsAt: DateTime.utc(2099, 9, 11),
      resetToken: '2099-09-10:0:50',
    );

    Widget sheet(MobileBilling value) => app(
      value,
      (context, ref) => opener('Messages', () => showMessageAllowance(context)),
      overrides: [
        messageAllowanceRepositoryProvider.overrideWithValue(_NoResets()),
      ],
    );

    testWidgets('a reader out of credits is shown Verify before Add credits, '
        'and Verify closes the sheet', (tester) async {
      await tester.pumpWidget(
        sheet(billing(awaiting: true, messages: perMessage)),
      );
      await tester.tap(find.text('Messages'));
      await tester.pumpAndSettle();

      expect(find.text(lead), findsOneWidget);
      final addCredits = find.text('Add credits to send messages');
      expect(addCredits, findsOneWidget);
      expect(
        tester.getTopLeft(leadKey).dy,
        lessThan(tester.getTopLeft(addCredits).dy),
      );

      await tapVerify(tester);
      expect(find.text('Verify screen'), findsOneWidget);
      expect(addCredits, findsNothing);
    });

    testWidgets('nothing waiting on the email leaves the sheet as it was', (
      tester,
    ) async {
      await tester.pumpWidget(
        sheet(billing(awaiting: false, messages: perMessage)),
      );
      await tester.tap(find.text('Messages'));
      await tester.pumpAndSettle();

      expect(leadKey, findsNothing);
      expect(find.text('Add credits to send messages'), findsOneWidget);
    });
  });

  group('the account card', () {
    Widget card(MobileBilling value) => app(
      value,
      (context, ref) => SingleChildScrollView(
        child: AccountOverviewCard(
          billing: AsyncData(value),
          onGetCredits: () {},
          onRetry: () {},
        ),
      ),
    );

    testWidgets('names the waiting credits and offers Verify above Upgrade', (
      tester,
    ) async {
      await tester.pumpWidget(card(billing(awaiting: true)));
      await tester.pumpAndSettle();

      expect(find.text(lead), findsOneWidget);
      final verify = find.byKey(const ValueKey('account-verify-email'));
      expect(verify, findsOneWidget);
      expect(find.text('Upgrade'), findsOneWidget);
      expect(
        tester.getTopLeft(verify).dy,
        lessThan(tester.getTopLeft(find.text('Upgrade')).dy),
      );

      await tester.tap(verify);
      await tester.pumpAndSettle();
      expect(find.text('Verify screen'), findsOneWidget);
    });

    testWidgets('offers only Upgrade once nothing waits', (tester) async {
      await tester.pumpWidget(card(billing(awaiting: false)));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('account-verify-email')), findsNothing);
      expect(find.text('Upgrade'), findsOneWidget);
    });
  });
}

Map<String, dynamic> _export(String format) => {
  'format': format,
  'available': false,
  // An older server's lock fields, which the app tolerates either way.
  'unlocked': true,
  'creditsRequired': 0,
  'downloadUrl': '/api/mobile/projects/book-1/export/$format',
  'filename': 'book.$format',
  'contentType': 'application/octet-stream',
};

/// A 28-page Balanced workbook whose plan is ready: far more than the empty
/// balance these tests hold, so approval meets its shortfall.
MobileProjectDetail _plannedBook() => MobileProjectDetail.fromJson({
  'id': 'book-1',
  'title': 'Launch Workbook',
  'bookType': 'workbook',
  'lengthPreset': 'standard',
  'qualityPreset': 'balanced',
  'coverEnabled': true,
  'illustrationsEnabled': true,
  'status': 'plan_ready',
  'statusLabel': 'Review your book plan',
  'progressPercent': 20,
  'currentAction': 'Ready for review.',
  'promptPreview': 'A workbook for teachers launching a course.',
  'targetPages': 28,
  'pageCount': 0,
  'imageCount': 0,
  'hasPlan': true,
  'exports': {'pdf': _export('pdf'), 'epub': _export('epub')},
  'createdAt': '2026-06-15T00:00:00.000Z',
  'updatedAt': '2026-06-15T00:00:00.000Z',
  'prompt': 'A workbook for teachers launching a course.',
  'language': 'en',
  'pages': const <Object>[],
  'plan': {
    'id': 'plan-1',
    'projectId': 'book-1',
    'version': 1,
    'status': 'ready',
    'title': 'Launch Workbook',
    'premise': 'Launch a course.',
    'audience': 'Teachers',
    'questions': const <Object>[],
    'chapters': const <Object>[],
    'createdAt': '2026-06-15T00:00:00.000Z',
    'updatedAt': '2026-06-15T00:00:00.000Z',
  },
});

/// Nothing here resets the allowance; the sheet only has to open.
class _NoResets implements MessageAllowanceRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not used in this test.');
}
