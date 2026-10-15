import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/book_matter.dart';
import 'package:tomeza/features/book_matter/presentation/book_credits_card.dart';
import 'package:tomeza/features/book_matter/presentation/made_with_credit_line.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import '../../billing/billing_paywall_harness.dart'
    show
        EmptyCreditLogRepository,
        FakeBillingRepository,
        FakeStoreBillingClient;
import 'fake_book_matter_repository.dart';

// The free tier's "Made with Tomeza" line in a book's Title & credits.
// Subscribing reprints nothing: a subscriber takes the line off one book at a
// time, free, and a free account is told it comes with a plan.

/// A subscriber's book printed while they were on the free tier.
const _printed = BookMatter(authorName: 'Parsa', creditPrinted: true);

/// A free account's book: the line is printed, and the next build prints it.
const _free = BookMatter(
  authorName: 'Parsa',
  madeWithCredit: true,
  creditPrinted: true,
);

const _queuedMessage =
    'Removing “Made with Tomeza”. Your book’s files are being refreshed, at '
    'no charge.';

/// The book page's own reads of the book, counted: each one past the first
/// is the removal's refresh reaching it.
class _BookReads {
  int status = 0;
  int detail = 0;

  List<Override> get overrides => [
    projectStatusProvider.overrideWith((ref, id) {
      status++;
      return const Stream<MobileProjectStatus>.empty();
    }),
    projectDetailProvider.overrideWith((ref, id) {
      detail++;
      return Completer<MobileProjectDetail>().future;
    }),
  ];

  /// Stands in for the book page, which watches both while it is open.
  Widget get page => Consumer(
    builder: (context, ref, _) {
      ref
        ..watch(projectStatusProvider('project-1'))
        ..watch(projectDetailProvider('project-1'));
      return const SizedBox.shrink();
    },
  );
}

Future<_BookReads> _open(
  WidgetTester tester,
  FakeBookMatterRepository repo, {
  FakeStoreBillingClient? store,
}) async {
  final reads = _BookReads();
  final navigator = GlobalKey<NavigatorState>();
  // Wide: the test font's square glyphs overflow the paywall's rows at phone
  // width, which is the paywall's test, not this one.
  await tester.binding.setSurfaceSize(const Size(800, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        bookMatterRepositoryProvider.overrideWithValue(repo),
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        storeBillingClientProvider.overrideWithValue(
          store ?? FakeStoreBillingClient(),
        ),
        creditLogRepositoryProvider.overrideWithValue(
          EmptyCreditLogRepository(),
        ),
        ...reads.overrides,
      ],
      child: MaterialApp(
        navigatorKey: navigator,
        theme: buildTomezaLightTheme(),
        home: const Scaffold(body: Text('library')),
      ),
    ),
  );
  // The book page is opened from the library, as in the app: a pop that
  // misses the sheet has a page to take away.
  navigator.currentState!.push(
    MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              reads.page,
              const BookCreditsCard(projectId: 'project-1'),
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('book-credits-open')));
  await tester.pumpAndSettle();
  expect((reads.status, reads.detail), (1, 1));
  return reads;
}

Future<void> _tap(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

/// Buys the Creator plan from the open paywall and closes the success dialog.
/// [onPurchase] runs as the store answers — where the server changes its mind.
Future<void> _buyPlan(
  WidgetTester tester,
  FakeStoreBillingClient store, {
  required void Function() onPurchase,
}) async {
  expect(find.byType(BillingPaywall), findsOneWidget);
  await _tap(tester, 'paywall-plan-tomeza.creator_monthly');
  final buy = find.byKey(const ValueKey('paywall-checkout-buy'));
  await tester.ensureVisible(buy);
  await tester.pumpAndSettle();
  await tester.tap(buy);
  // The checkout spins until the store answers, so nothing settles here.
  await tester.pump();
  expect(store.buyCalls.single.product.id, 'tomeza.creator_monthly');
  onPurchase();
  store.emit(
    const StorePurchaseUpdate(
      productId: 'tomeza.creator_monthly',
      status: StorePurchaseStatus.purchased,
      purchaseToken: 'plan-token-1',
      purchaseId: 'order-1',
      pendingCompletePurchase: true,
    ),
  );
  await tester.pumpAndSettle();
  final success = find.byKey(const ValueKey('billing-purchase-success-dialog'));
  expect(success, findsOneWidget);
  await tester.tap(
    find.descendant(of: success, matching: find.byType(FilledButton)),
  );
  await tester.pumpAndSettle();
}

Finder get _sheetOpen => find.byKey(const ValueKey('matter-save'));

/// A point on the page above the sheet: a tap there is the barrier's.
const _aboveTheSheet = Offset(20, 20);

/// Taps Remove it and leaves the removal in flight until the gate opens.
Future<Completer<void>> _removeAndHold(
  WidgetTester tester,
  FakeBookMatterRepository repo,
) async {
  final gate = repo.writeGate = Completer<void>();
  final remove = find.byKey(const ValueKey('matter-credit-remove'));
  await tester.ensureVisible(remove);
  await tester.tap(remove);
  await tester.pump();
  expect(find.text('Removing'), findsOneWidget);
  return gate;
}

void main() {
  group('what the sheet offers', () {
    test('by account and by what the files carry', () {
      expect(MadeWithCreditOffer.of(_printed), MadeWithCreditOffer.remove);
      expect(MadeWithCreditOffer.of(_free), MadeWithCreditOffer.plans);
      // A free account's book still being written: the line is coming.
      expect(
        MadeWithCreditOffer.of(const BookMatter(madeWithCredit: true)),
        MadeWithCreditOffer.plans,
      );
      expect(
        MadeWithCreditOffer.of(const BookMatter()),
        MadeWithCreditOffer.none,
      );
    });

    test('an older server that never says what the files carry offers no '
        'removal', () {
      final matter = BookMatter.fromJson({
        'authorName': 'Parsa',
        'madeWithCredit': false,
      });
      expect(matter.creditPrinted, isFalse);
      expect(MadeWithCreditOffer.of(matter), MadeWithCreditOffer.none);
    });

    test('the removal answer, by wire', () {
      final removal = BookMatterCreditRemoval.fromJson({
        'bookMatter': {'authorName': 'Parsa', 'creditPrinted': false},
        'reprint': 'queued',
      });
      expect(removal.reprint, BookMatterReprint.queued);
      expect(removal.bookMatter.creditPrinted, isFalse);
      expect(removal.message, _queuedMessage);
      expect(
        BookMatterCreditRemoval.fromJson({
          'bookMatter': <String, dynamic>{},
          'reprint': 'none',
        }).message,
        '“Made with Tomeza” is already gone from this book’s files.',
      );
    });
  });

  testWidgets('a subscriber removes the line, free, and the page shows the '
      'refresh', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed);
    final reads = await _open(tester, repo);

    expect(
      find.text(
        'This book’s files still carry a small “Made with Tomeza” line on the '
        'copyright page. Your plan removes it, free.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('matter-credit-plans')), findsNothing);

    await _tap(tester, 'matter-credit-remove');

    expect(repo.writes.single.method, 'POST remove-credit');
    expect(repo.writes.single.projectId, 'project-1');
    // Like a save: the sheet goes, the page opens its status again, and says
    // what is happening.
    expect(_sheetOpen, findsNothing);
    expect((reads.status, reads.detail), (2, 2));
    expect(find.text(_queuedMessage), findsOneWidget);
  });

  testWidgets('a removal the sheet was tapped away from still refreshes the '
      'page, and the page says so', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed);
    final reads = await _open(tester, repo);

    final gate = await _removeAndHold(tester, repo);
    await tester.tapAt(_aboveTheSheet);
    await tester.pumpAndSettle();
    expect(_sheetOpen, findsNothing);

    gate.complete();
    await tester.pumpAndSettle();
    expect((reads.status, reads.detail), (2, 2));
    expect(find.text(_queuedMessage), findsOneWidget);
  });

  testWidgets('a removal that lands while the sheet is still sliding away '
      'leaves the book page where it is', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed);
    final reads = await _open(tester, repo);

    final gate = await _removeAndHold(tester, repo);
    await tester.tapAt(_aboveTheSheet);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    // Mid-slide: the line is still built, but its route is not on top.
    expect(find.byType(MadeWithCreditLine), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byType(MadeWithCreditLine), findsNothing);
    expect(find.byKey(const ValueKey('book-credits-card')), findsOneWidget);
    expect(find.text('library'), findsNothing);
    expect((reads.status, reads.detail), (2, 2));
    expect(find.text(_queuedMessage), findsOneWidget);
  });

  testWidgets('a lapsed plan refused while the sheet is still sliding away '
      'opens no plans over the book page', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed)
      ..removeCreditError = FakeBookMatterRepository.subscriptionRequired;
    await _open(tester, repo);

    final gate = await _removeAndHold(tester, repo);
    await tester.tapAt(_aboveTheSheet);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byType(MadeWithCreditLine), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byType(BillingPaywall), findsNothing);
    expect(find.byKey(const ValueKey('book-credits-card')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('book-matter-credit-not-removed')),
      findsOneWidget,
    );
  });

  testWidgets('typed changes are saved first, and the removal waits', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(matter: _printed);
    await _open(tester, repo);

    final author = find.byKey(const ValueKey('matter-author'));
    await tester.enterText(author, 'P. Ravan');
    await tester.pump();
    await _tap(tester, 'matter-credit-remove');

    // A reprint would refuse the save behind it; nothing was sent.
    expect(repo.writes, isEmpty);
    expect(find.text('Save your changes first'), findsOneWidget);
    expect(_sheetOpen, findsOneWidget);
    expect(tester.widget<TextField>(author).controller!.text, 'P. Ravan');

    await _tap(tester, 'matter-save');
    expect(repo.writes.single.method, 'PATCH matter');
  });

  testWidgets('files that never carried it: the sheet says it is already '
      'gone, and the book is left alone', (tester) async {
    final repo = FakeBookMatterRepository(
      matter: _printed,
      removalReprint: BookMatterReprint.none,
    );
    final reads = await _open(tester, repo);

    await _tap(tester, 'matter-credit-remove');

    expect(repo.writes.single.method, 'POST remove-credit');
    expect(_sheetOpen, findsOneWidget);
    expect(
      find.text('“Made with Tomeza” is already gone from this book’s files.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('matter-credit-remove')), findsNothing);
    expect((reads.status, reads.detail), (1, 1));
  });

  testWidgets('a free account is told it comes with a plan, and See plans '
      'opens the plans', (tester) async {
    final repo = FakeBookMatterRepository(matter: _free);
    await _open(tester, repo);

    expect(
      find.text(
        'Free books carry a small “Made with Tomeza” line on the copyright '
        'page. Any plan lets you take it off.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('matter-credit-remove')), findsNothing);

    await _tap(tester, 'matter-credit-plans');

    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(BillingPaywall),
        matching: find.text(madeWithCreditPlanMessage),
      ),
      findsOneWidget,
    );
    expect(repo.writes, isEmpty);
  });

  testWidgets('a plan bought from See plans offers the removal at once', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(matter: _free);
    final store = FakeStoreBillingClient();
    await _open(tester, repo, store: store);

    await _tap(tester, 'matter-credit-plans');
    await _buyPlan(
      tester,
      store,
      // The server now has a subscriber; the book still carries the line.
      onPurchase: () => repo.matter = _printed,
    );

    // The book was read again, and the line is now the subscriber's.
    expect(repo.calls.where((call) => call.method == 'GET matter').length, 2);
    expect(find.byKey(const ValueKey('matter-credit-remove')), findsOneWidget);
    expect(find.byKey(const ValueKey('matter-credit-plans')), findsNothing);
  });

  testWidgets('a plan that lapsed: the refusal opens the plans, and the line '
      'reads as a free book’s after', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed)
      ..removeCreditError = FakeBookMatterRepository.subscriptionRequired;
    await _open(tester, repo);

    await _tap(tester, 'matter-credit-remove');

    expect(repo.writes.single.method, 'POST remove-credit');
    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(BillingPaywall),
        matching: find.text(
          'Removing the “Made with Tomeza” line comes with any plan.',
        ),
      ),
      findsOneWidget,
    );

    Navigator.of(tester.element(find.byType(BillingPaywall))).pop();
    await tester.pumpAndSettle();
    expect(find.byType(BillingPaywall), findsNothing);
    expect(_sheetOpen, findsOneWidget);
    expect(find.byKey(const ValueKey('matter-credit-plans')), findsOneWidget);
    expect(find.byKey(const ValueKey('matter-credit-remove')), findsNothing);
    expect(find.byKey(const ValueKey('matter-credit-error')), findsNothing);
  });

  testWidgets('a plan bought after that refusal carries the removal through', (
    tester,
  ) async {
    final repo = FakeBookMatterRepository(matter: _printed)
      ..removeCreditError = FakeBookMatterRepository.subscriptionRequired;
    final store = FakeStoreBillingClient();
    final reads = await _open(tester, repo, store: store);

    await _tap(tester, 'matter-credit-remove');
    await _buyPlan(
      tester,
      store,
      onPurchase: () => repo.removeCreditError = null,
    );

    // Read again, found a subscriber's book, and removed it as asked.
    expect(repo.calls.where((call) => call.method == 'GET matter').length, 2);
    expect(repo.writes.map((call) => call.method), [
      'POST remove-credit',
      'POST remove-credit',
    ]);
    expect(_sheetOpen, findsNothing);
    expect((reads.status, reads.detail), (2, 2));
    expect(find.text(_queuedMessage), findsOneWidget);
  });

  testWidgets('a busy or unfinished book says why in the server’s words, and '
      'Remove it stays', (tester) async {
    final repo = FakeBookMatterRepository(matter: _printed)
      ..removeCreditError = FakeBookMatterRepository.unfinished;
    final reads = await _open(tester, repo);

    await _tap(tester, 'matter-credit-remove');

    expect(_sheetOpen, findsOneWidget);
    expect(find.text('Couldn’t remove it'), findsOneWidget);
    expect(
      find.text('Wait for this book to finish, then try again.'),
      findsOneWidget,
    );
    expect((reads.status, reads.detail), (1, 1));

    repo.removeCreditError = null;
    await _tap(tester, 'matter-credit-remove');
    expect(repo.writes, hasLength(2));
    expect(_sheetOpen, findsNothing);
    expect(find.text(_queuedMessage), findsOneWidget);
  });

  testWidgets('a subscriber’s book with nothing printed shows no line at all, '
      'older server included', (tester) async {
    final repo = FakeBookMatterRepository(
      matter: BookMatter.fromJson({
        'authorName': 'Parsa',
        'madeWithCredit': false,
      }),
    );
    await _open(tester, repo);

    for (final key in [
      'matter-credit-note',
      'matter-credit-printed',
      'matter-credit-plans',
      'matter-credit-remove',
    ]) {
      expect(find.byKey(ValueKey(key)), findsNothing, reason: key);
    }
    expect(find.textContaining('Made with Tomeza'), findsNothing);
  });
}
