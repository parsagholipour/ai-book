import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';

MobileBillingProduct plan(String sku, int credits) => MobileBillingProduct(
  sku: sku,
  title: sku,
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: credits,
  priceMicros: 19990000,
  currency: 'USD',
);

void main() {
  // A Balanced, 20-page, illustrated book with a drawn cover, at the compiled
  // prices: 40 plan + 350 base + 20 × 8 + 3 pictures and a cover × 45 = 730
  // credits. No export line: a written book downloads free.
  test('counts each plan in typical books at the compiled prices', () {
    expect(
      planBooksLine(plan('tomeza.creator_monthly', 6000), const {}),
      'About 8 illustrated 20-page books a month',
    );
    expect(
      typicalBooksPerMonth(plan('tomeza.pro_monthly', 15000), const {}),
      20,
    );
    expect(
      typicalBooksPerMonth(plan('tomeza.max_monthly', 80000), const {}),
      109,
    );
  });

  test('follows a live price change', () {
    // Doubling the per-page rate makes the same book 890 credits.
    expect(
      typicalBooksPerMonth(plan('tomeza.creator_monthly', 6000), const {
        'fullBookPerPage': 16,
      }),
      6,
    );
  });

  test('counts a yearly plan in books a month, as its credits arrive', () {
    const yearly = MobileBillingProduct(
      sku: 'tomeza.creator_yearly',
      title: 'Creator yearly',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 72000,
      priceMicros: 179990000,
      currency: 'USD',
      billingPeriod: 'P1Y',
    );
    expect(
      planBooksLine(yearly, const {}),
      'About 8 illustrated 20-page books a month',
    );
  });

  test('says one book rather than "1 books"', () {
    expect(
      planBooksLine(plan('tomeza.creator_monthly', 900), const {}),
      'About one illustrated 20-page book a month',
    );
  });
}
