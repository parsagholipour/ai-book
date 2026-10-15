import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/first_book_offer_store.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/first_book_offer.dart';

import 'billing_export_offer_harness.dart';
import 'billing_paywall_harness.dart';

/// The one moment a plan is offered unasked: a free reader's first finished
/// book. Once per account on this phone, never to a reader on a plan, never
/// for an author's own book, and every way out leads back to the book.
void main() {
  setUpAll(loadExportOfferFonts);

  Future<MemoryFirstBookOfferStore> pump(
    WidgetTester tester, {
    String source = 'generated',
    String? planTier,
    MemoryFirstBookOfferStore? store,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final offers = store ?? MemoryFirstBookOfferStore();
    final billing = ExportOfferRepository();
    final base = fakeBilling(availableCredits: 200, planTier: planTier);
    billing.billing = MobileBilling(
      purchaseAccountId: base.purchaseAccountId,
      credits: base.credits,
      entitlements: base.entitlements,
      products: exportPlans,
      creditCosts: const {'paidMaxBookPages': 200},
      plan: base.plan,
      paidMaxBookPages: 200,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectDetailProvider.overrideWith((ref, id) async => _book(source)),
          billingRepositoryProvider.overrideWithValue(billing),
          storeBillingClientProvider.overrideWithValue(ExportOfferStore()),
          firstBookOfferStoreProvider.overrideWithValue(offers),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) => ElevatedButton(
                onPressed: () =>
                    offerPlanForFirstBook(context, ref, projectId: 'project-1'),
                child: const Text('Book is ready'),
              ),
            ),
          ),
        ),
      ),
    );
    return offers;
  }

  Future<void> ready(WidgetTester tester) async {
    await tester.tap(find.text('Book is ready'));
    await tester.pumpAndSettle();
  }

  testWidgets('celebrates a free reader\'s first book and offers a plan once', (
    tester,
  ) async {
    final offers = await pump(tester);
    await ready(tester);

    expect(find.text('YOUR FIRST BOOK IS READY'), findsOneWidget);
    expect(find.text('“The Moon Rabbit”\nis yours.'), findsOneWidget);
    // Every book downloads free, so a plan is sold on what it really adds.
    expect(find.text('Downloads included'), findsNothing);
    expect(find.textContaining('comes with its downloads'), findsNothing);
    expect(find.text('Credits every month'), findsOneWidget);
    expect(find.text('Books up to 200 pages'), findsOneWidget);
    expect(find.text('Word export'), findsOneWidget);
    expect(find.text('Voice calls and audiobooks'), findsOneWidget);
    // The checkout opens on Creator, "Start here".
    expect(find.byKey(const ValueKey('first-book-upgrade')), findsOneWidget);
    expect(find.textContaining('Start Creator'), findsOneWidget);

    final keepFree = find.byKey(const ValueKey('first-book-keep-free'));
    await tester.scrollUntilVisible(
      keepFree,
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(keepFree);
    await tester.pumpAndSettle();
    await tester.tap(keepFree);
    await tester.pumpAndSettle();
    expect(find.text('YOUR FIRST BOOK IS READY'), findsNothing);
    expect(await offers.wasShown('test-purchase-account'), isTrue);

    // Never again for this account.
    await ready(tester);
    expect(find.text('YOUR FIRST BOOK IS READY'), findsNothing);
  });

  testWidgets('a reader on a plan is never offered one', (tester) async {
    final offers = await pump(tester, planTier: 'creator');
    await ready(tester);

    expect(find.text('YOUR FIRST BOOK IS READY'), findsNothing);
    expect(await offers.wasShown('test-purchase-account'), isFalse);
  });

  testWidgets('an author\'s own book is not the moment', (tester) async {
    await pump(tester, source: 'imported');
    await ready(tester);

    expect(find.text('YOUR FIRST BOOK IS READY'), findsNothing);
  });

  testWidgets('an account this phone already showed it to is not shown again', (
    tester,
  ) async {
    await pump(
      tester,
      store: MemoryFirstBookOfferStore(['test-purchase-account']),
    );
    await ready(tester);

    expect(find.text('YOUR FIRST BOOK IS READY'), findsNothing);
  });
}

MobileProjectDetail _book(String source) {
  MobileExportAvailability export(String format, String type) =>
      MobileExportAvailability(
        format: format,
        available: true,
        downloadUrl: '/api/mobile/projects/project-1/export/$format',
        filename: 'book.$format',
        contentType: type,
      );
  return MobileProjectDetail(
    id: 'project-1',
    title: 'The Moon Rabbit',
    bookType: 'short_story',
    bookTypeChoice: 'children_story',
    lengthPreset: 'short',
    qualityPreset: 'balanced',
    status: 'complete',
    statusLabel: 'Ready',
    progressPercent: 100,
    currentAction: 'Ready to read.',
    promptPreview: 'A bedtime story',
    targetPages: 12,
    pageCount: 12,
    imageCount: 12,
    hasPlan: true,
    exports: MobileExportSet(
      pdf: export('pdf', 'application/pdf'),
      epub: export('epub', 'application/epub+zip'),
    ),
    createdAt: DateTime.utc(2026, 10, 13),
    updatedAt: DateTime.utc(2026, 10, 13),
    prompt: 'A bedtime story',
    language: 'en',
    pages: const [],
    source: source,
  );
}
