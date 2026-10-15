import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// The two operator switches the billing payload carries for book creation:
/// the longest book any plan writes (`paidMaxBookPages`) and whether Ultra may
/// start a new book (`ultraTierEnabled`). Each has a top-level field, a copy in
/// the price table, and an answer for a server that sends neither.
Map<String, dynamic> _payload([Map<String, dynamic> extra = const {}]) => {
  'credits': {
    'available': 100,
    'reserved': 0,
    'lifetimeGranted': 100,
    'lifetimeSpent': 0,
  },
  'entitlements': <dynamic>[],
  'products': <dynamic>[],
  'creditCosts': <String, dynamic>{},
  ...extra,
};

void main() {
  group('paidMaxBookPages', () {
    test('reads the top-level field', () {
      final billing = MobileBilling.fromJson(
        _payload({'paidMaxBookPages': 200}),
      );
      expect(billing.paidMaxBookPages, 200);
      expect(billing.exceedsBookPagesCeiling(200), isFalse);
      expect(billing.exceedsBookPagesCeiling(201), isTrue);
    });

    test('falls back to the price table copy', () {
      final billing = MobileBilling.fromJson(
        _payload({
          'creditCosts': {'paidMaxBookPages': 150},
        }),
      );
      expect(billing.paidMaxBookPages, 150);
    });

    test('an older server that sends neither keeps the 600-page ceiling', () {
      final billing = MobileBilling.fromJson(_payload());
      expect(billing.paidMaxBookPages, maxPlanBookPages);
      expect(billing.exceedsBookPagesCeiling(600), isFalse);
    });

    test('a nonsense value is never a ceiling below one page or past 600', () {
      expect(
        MobileBilling.fromJson(
          _payload({'paidMaxBookPages': 0}),
        ).paidMaxBookPages,
        maxPlanBookPages,
      );
      expect(
        MobileBilling.fromJson(
          _payload({'paidMaxBookPages': 9000}),
        ).paidMaxBookPages,
        maxPlanBookPages,
      );
    });

    test('the free cap keeps its own meaning beside the ceiling', () {
      final billing = MobileBilling.fromJson(
        _payload({'maxBookPages': 30, 'paidMaxBookPages': 200}),
      );
      // 45 pages: a plan perk on the free tier, inside the ceiling.
      expect(billing.locksBookPages(45), isTrue);
      expect(billing.exceedsBookPagesCeiling(45), isFalse);
      // 250 pages: past what any plan writes.
      expect(billing.exceedsBookPagesCeiling(250), isTrue);
    });
  });

  group('the two length refusals', () {
    const body = {
      'pageLimit': {'limit': 200, 'requestedPages': 250, 'maxPages': 200},
    };

    test('past the free cap is the long-book offer, up to the ceiling', () {
      final limit = pageLimitFromError(
        const ApiException(
          code: 'PAGE_LIMIT_EXCEEDED',
          message: 'Free books go up to 30 pages.',
          statusCode: 403,
          details: {
            'pageLimit': {'limit': 30, 'requestedPages': 45, 'maxPages': 200},
          },
        ),
      );
      expect(limit?.limit, 30);
      expect(limit?.maxPages, 200);
    });

    test('past the ceiling is a sentence, never the long-book offer', () {
      // Same numbers in the body, but no plan unlocks them: the code decides.
      expect(
        pageLimitFromError(
          const ApiException(
            code: 'BOOK_LENGTH_UNAVAILABLE',
            message: 'Books longer than 200 pages aren’t available yet.',
            statusCode: 403,
            details: body,
          ),
        ),
        isNull,
      );
      expect(
        userFacingError(
          const ApiException(
            code: 'BOOK_LENGTH_UNAVAILABLE',
            message: 'Books longer than 200 pages aren’t available yet.',
            statusCode: 403,
            details: body,
          ),
        ),
        'Books longer than 200 pages aren’t available yet.',
      );
    });
  });

  group('ultraTierEnabled', () {
    test('reads the top-level flag', () {
      expect(
        MobileBilling.fromJson(
          _payload({'ultraTierEnabled': false}),
        ).ultraTierEnabled,
        isFalse,
      );
      expect(
        MobileBilling.fromJson(
          _payload({'ultraTierEnabled': true}),
        ).ultraTierEnabled,
        isTrue,
      );
    });

    test('falls back to the price table 0/1', () {
      expect(
        MobileBilling.fromJson(
          _payload({
            'creditCosts': {'ultraTierEnabled': 0},
          }),
        ).ultraTierEnabled,
        isFalse,
      );
      expect(
        MobileBilling.fromJson(
          _payload({
            'creditCosts': {'ultraTierEnabled': 1},
          }),
        ).ultraTierEnabled,
        isTrue,
      );
    });

    test('an older server that sends neither always offered Ultra', () {
      expect(MobileBilling.fromJson(_payload()).ultraTierEnabled, isTrue);
    });
  });
}
