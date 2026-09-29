import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/presentation/studio_cover_picker.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/media/photo_picker.dart';
import 'package:tomeza/shared/ui/authed_network_image.dart';

import '../../billing/billing_paywall_harness.dart';
import '../../support/fake_studio_repository.dart';
import '../../support/studio_cover_test_support.dart';

// A cover three ways: designed (free, the default), the author's own picture,
// or one drawn by AI at the cover price. Each applies at once; only the paid
// one asks first, and a cover being made is watched until it lands.

Widget _app(
  FakeStudioRepository studio, {
  CoverTestPicker? picker,
  FakeBillingRepository? billing,
  FakeStoreBillingClient? store,
}) {
  return ProviderScope(
    overrides: [
      studioRepositoryProvider.overrideWithValue(studio),
      ...coverTestOverrides(picker: picker, billing: billing, store: store),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              onPressed: () => showStudioCoverSheet(context, projectId: 'p1'),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> _open(
  WidgetTester tester,
  FakeStudioRepository studio, {
  CoverTestPicker? picker,
  FakeBillingRepository? billing,
  FakeStoreBillingClient? store,
  Size size = const Size(390, 1200),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    _app(studio, picker: picker, billing: billing, store: store),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Finder _chosen(String choice) => find.descendant(
  of: find.byKey(ValueKey('cover-choice-$choice')),
  matching: find.byIcon(Icons.radio_button_checked),
);

int _fetches(FakeStudioRepository studio) =>
    studio.calls.where((call) => call == 'getManuscript').length;

void main() {
  testWidgets('three covers, designed first, the AI one priced', (
    tester,
  ) async {
    final studio = FakeStudioRepository(title: 'The Lighthouse Letter');
    await _open(tester, studio);

    expect(find.text('Designed'), findsOneWidget);
    expect(find.text('Free'), findsOneWidget);
    expect(find.text('Your own picture'), findsOneWidget);
    expect(find.text('Generate with AI'), findsOneWidget);
    // The operator's price table leaves the cover at its default rate.
    expect(find.text('120 credits'), findsOneWidget);
    expect(_chosen('design'), findsOneWidget);
    expect(
      find.text('A clean typographic cover with your title and name.'),
      findsOneWidget,
    );

    // Already designed: choosing it again asks nothing of the server.
    await tester.tap(find.text('Designed'));
    await tester.pumpAndSettle();
    expect(studio.calls, isNot(contains('useDesignedCover')));
  });

  testWidgets('a picture of your own uploads with its progress in place', (
    tester,
  ) async {
    final studio = FakeStudioRepository()..coverGate = Completer<void>();
    final picker = CoverTestPicker(result: coverTestPhoto());
    await _open(tester, studio, picker: picker);

    await tester.tap(find.text('Your own picture'));
    await tester.pumpAndSettle();
    expect(find.text('Your cover picture'), findsOneWidget);
    await tester.tap(find.text('Take a photo'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(picker.calls.single, (
      source: ImageSource.camera,
      purpose: PhotoPickerPurpose.bookImage,
    ));
    expect(studio.calls, contains('uploadCover:lighthouse.jpg'));
    expect(find.text('Uploading your picture…'), findsOneWidget);

    studio.coverGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('Uploading your picture…'), findsNothing);
    expect(_chosen('upload'), findsOneWidget);
    expect(
      find.textContaining('Your picture is the front cover.'),
      findsOneWidget,
    );
  });

  testWidgets('an upload the server refuses says why, where it happened', (
    tester,
  ) async {
    final studio = FakeStudioRepository()
      ..coverError = const ApiException(
        code: 'IMAGE_TOO_LARGE',
        message: 'That picture is too large. Choose one under 15 MB.',
        statusCode: 413,
      );
    await _open(tester, studio);

    await tester.tap(find.text('Your own picture'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose from photos'));
    await tester.pumpAndSettle();

    expect(find.text('Could not change your cover'), findsOneWidget);
    expect(
      find.text('That picture is too large. Choose one under 15 MB.'),
      findsOneWidget,
    );
    expect(_chosen('design'), findsOneWidget);
  });

  testWidgets('an AI cover is confirmed at its price, then watched until it '
      'lands', (tester) async {
    final studio = FakeStudioRepository();
    await _open(tester, studio);

    await tester.tap(find.text('Generate with AI'));
    await tester.pumpAndSettle();
    expect(find.text('Generate a cover with AI?'), findsOneWidget);
    await tester.tap(find.text('Generate cover · 120 credits'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(studio.calls, contains('generateCover'));
    expect(studio.coverRequestIds, hasLength(1));
    // A real wait: the sparkle, a line that moves on, a paced bar.
    expect(find.text('Reading your book…'), findsOneWidget);
    expect(find.byKey(const ValueKey('cover-veil')), findsOneWidget);

    // Nothing yet: the next look still finds it being drawn.
    final before = _fetches(studio);
    await tester.pump(studioCoverPollInterval);
    await tester.pump();
    expect(_fetches(studio), before + 1);
    expect(find.byKey(const ValueKey('cover-drawing')), findsOneWidget);

    // It lands.
    studio.cover = const ManuscriptCover(
      source: ManuscriptCoverSource.ai,
      pending: false,
      imageUrl: '/assets/images/p1/cover.png',
    );
    await tester.pump(studioCoverPollInterval);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cover-drawing')), findsNothing);
    expect(find.byKey(const ValueKey('cover-veil')), findsNothing);
    expect(_chosen('ai'), findsOneWidget);
    expect(find.textContaining('Drawn from your book'), findsOneWidget);

    // Landed means the watching stops.
    final settled = _fetches(studio);
    await tester.pump(studioCoverPollInterval * 3);
    expect(_fetches(studio), settled);
  });

  testWidgets('a cover drawn again shows from its new URL once it lands', (
    tester,
  ) async {
    // Every drawn cover is cover.png; the API's `?v=` is what tells them apart.
    final studio = FakeStudioRepository()
      ..cover = const ManuscriptCover(
        source: ManuscriptCoverSource.ai,
        pending: false,
        imageUrl: '/assets/images/p1/cover.png?v=one',
      );
    await _open(tester, studio);
    AuthedNetworkImage preview() => tester.widget<AuthedNetworkImage>(
      find.byType(AuthedNetworkImage).first,
    );
    expect(preview().url, '/assets/images/p1/cover.png?v=one');
    expect(preview().cacheBuster, isNull);

    await tester.tap(find.text('Generate with AI'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Generate cover · 120 credits'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    studio.cover = const ManuscriptCover(
      source: ManuscriptCoverSource.ai,
      pending: false,
      imageUrl: '/assets/images/p1/cover.png?v=two',
    );
    await tester.pump(studioCoverPollInterval);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cover-veil')), findsNothing);
    expect(preview().url, '/assets/images/p1/cover.png?v=two');
    expect(preview().cacheBuster, isNull);
  });

  testWidgets('trading an AI cover for a designed one asks first', (
    tester,
  ) async {
    final studio = FakeStudioRepository()
      ..cover = const ManuscriptCover(
        source: ManuscriptCoverSource.ai,
        pending: false,
        imageUrl: '/assets/images/p1/cover.png',
      );
    await _open(tester, studio);
    expect(_chosen('ai'), findsOneWidget);

    await tester.tap(find.text('Designed'));
    await tester.pumpAndSettle();
    expect(find.text('Use a designed cover?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(studio.calls, isNot(contains('useDesignedCover')));

    await tester.tap(find.text('Designed'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use designed cover'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(studio.calls, contains('useDesignedCover'));
    expect(_chosen('design'), findsOneWidget);
    // The designed cover is being set.
    expect(find.text('Setting your title…'), findsOneWidget);

    studio.cover = const ManuscriptCover(
      source: ManuscriptCoverSource.design,
      pending: false,
      imageUrl: '/assets/images/p1/cover.png',
    );
    await tester.pump(studioCoverPollInterval);
    await tester.pumpAndSettle();
    expect(find.text('Setting your title…'), findsNothing);
  });

  testWidgets('short of credits opens the paywall, and a purchase offers the '
      'cover again', (tester) async {
    final studio = FakeStudioRepository()
      ..coverError = const ApiException(
        code: 'INSUFFICIENT_CREDITS',
        message: 'You need more credits for this action.',
        statusCode: 402,
        details: {'requiredCredits': 120},
      );
    final store = FakeStoreBillingClient();
    // Wide: the test font's square glyphs overflow the paywall's pack rows
    // at phone width, which is the paywall's test, not this one.
    await _open(tester, studio, store: store, size: const Size(800, 1200));

    await tester.tap(find.text('Generate with AI'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Generate cover · 120 credits'));
    await tester.pumpAndSettle();
    expect(find.byType(BillingPaywall), findsOneWidget);
    // Nothing was drawn, so the picker is not waiting on anything.
    expect(find.byKey(const ValueKey('cover-drawing')), findsNothing);

    final sheetScrollable = find
        .descendant(
          of: find.byType(BillingPaywall),
          matching: find.byType(Scrollable),
        )
        .first;
    final pack = find.byKey(
      const ValueKey('paywall-topup-tomeza.credit_pack_1'),
    );
    await tester.scrollUntilVisible(pack, 200, scrollable: sheetScrollable);
    await tester.tap(pack);
    await tester.pumpAndSettle();
    final buy = find.byKey(const ValueKey('paywall-checkout-buy'));
    await tester.ensureVisible(buy);
    await tester.pumpAndSettle();
    await tester.tap(buy);
    await tester.pump();
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'purchase-token-1',
        purchaseId: 'order-1',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();
    final success = find.byKey(
      const ValueKey('billing-purchase-success-dialog'),
    );
    expect(success, findsOneWidget);
    await tester.tap(
      find.descendant(of: success, matching: find.byType(FilledButton)),
    );
    await tester.pumpAndSettle();

    // The purchase is answered: the cover it was bought for is offered again.
    expect(find.text('Generate a cover with AI?'), findsOneWidget);
    await tester.tap(find.text('Generate cover · 120 credits'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(studio.calls.where((call) => call == 'generateCover'), hasLength(2));
    // A refused request is not replayed: the retry is a request of its own.
    expect(studio.coverRequestIds.toSet(), hasLength(2));
    expect(find.text('Reading your book…'), findsOneWidget);
  });

  testWidgets('a drawing the server gave up on says the cover stayed', (
    tester,
  ) async {
    final studio = FakeStudioRepository();
    await _open(tester, studio);
    await tester.tap(find.text('Generate with AI'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Generate cover · 120 credits'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    studio.cover = ManuscriptCover.designed;
    await tester.pump(studioCoverPollInterval);
    await tester.pumpAndSettle();

    expect(find.text('Your cover didn’t change'), findsOneWidget);
    expect(_chosen('design'), findsOneWidget);
  });
}
