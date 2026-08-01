import 'package:flutter/material.dart';

import '../domain/billing_models.dart';

/// The cards the paywall is built from: the banner saying where you are now, a
/// plan card per tier, and the smaller tile for one-off top-ups.

class BillingPlanBanner extends StatelessWidget {
  const BillingPlanBanner({required this.billing, super.key});

  final MobileBilling? billing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final plan = billing?.plan;
    final allowance = billing?.allowance;
    final quota = billing?.imageQuota;
    final credits = billing?.credits.available;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.savings_outlined, color: colors.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    credits == null
                        ? 'Checking your balance'
                        : '$credits credits available',
                    style: text.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (plan != null)
                  Chip(
                    label: Text(plan.label),
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  ),
              ],
            ),
            if (allowance != null && allowance.monthlyCredits > 0) ...[
              const SizedBox(height: 8),
              Text(
                '${allowance.planCredits} of ${allowance.monthlyCredits} monthly credits left'
                '${_resetSuffix(allowance.resetsAt)}',
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            if (quota != null) ...[
              const SizedBox(height: 4),
              Text(
                quota.isExhausted
                    ? 'Illustrated books used up${_resetSuffix(quota.resetsAt)}'
                    : '${quota.remaining} of ${quota.limit} illustrated books left this month',
                style: text.bodySmall?.copyWith(
                  color: quota.isExhausted
                      ? colors.error
                      : colors.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class BillingPlanCard extends StatelessWidget {
  const BillingPlanCard({
    required this.product,
    required this.isCurrentPlan,
    required this.pending,
    required this.onBuy,
    this.storeProduct,
    super.key,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;
  final bool isCurrentPlan;
  final bool pending;
  final VoidCallback onBuy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final highlighted = product.sku == 'tomeza.pro_monthly' && !isCurrentPlan;

    return Card(
      elevation: highlighted ? 3 : null,
      shape: highlighted
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: colors.primary, width: 1.5),
            )
          : null,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.workspace_premium_outlined, color: colors.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    product.title,
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (isCurrentPlan)
                  Chip(
                    label: const Text('Current'),
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                  )
                else if (highlighted)
                  Chip(
                    label: const Text('Most popular'),
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    backgroundColor: colors.primaryContainer,
                  ),
              ],
            ),
            const SizedBox(height: 10),
            for (final benefit in planBenefits(product)) ...[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.check, size: 18, color: colors.primary),
                  const SizedBox(width: 8),
                  Expanded(child: Text(benefit, style: text.bodyMedium)),
                ],
              ),
              const SizedBox(height: 4),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton(
                onPressed: storeProduct != null && !pending && !isCurrentPlan
                    ? onBuy
                    : null,
                child: pending
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          semanticsLabel: 'Purchase pending',
                        ),
                      )
                    : Text(
                        isCurrentPlan
                            ? 'Your plan'
                            : '${storeProduct?.price ?? fallbackPrice(product)} / month',
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class BillingTopUpTile extends StatelessWidget {
  const BillingTopUpTile({
    required this.product,
    required this.pending,
    required this.onBuy,
    this.storeProduct,
    super.key,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;
  final bool pending;
  final VoidCallback onBuy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              product.productType == 'CREDIT_PACK'
                  ? Icons.add_card_outlined
                  : Icons.lock_open_outlined,
              color: colors.primary,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    product.title,
                    style: text.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${product.benefitLabel} · never expires',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            FilledButton.tonal(
              onPressed: storeProduct != null && !pending ? onBuy : null,
              child: pending
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'Purchase pending',
                      ),
                    )
                  : Text(storeProduct?.price ?? fallbackPrice(product)),
            ),
          ],
        ),
      ),
    );
  }
}

/// What a plan is actually worth, in the order someone comparing cares about.
List<String> planBenefits(MobileBillingProduct product) {
  return <String>[
    '${_thousands(product.creditAmount)} credits every month',
    'Unlimited illustrated books',
    'Bring your own manuscript',
    if (product.sku == 'tomeza.max_monthly')
      'Enough for a book a day, with room to spare'
    else if (product.sku == 'tomeza.pro_monthly')
      'Room for around a book a week',
  ];
}

String fallbackPrice(MobileBillingProduct product) {
  final price = product.priceMicros / 1000000;
  return '${product.currency} ${price.toStringAsFixed(2)}';
}

String _thousands(int value) {
  final digits = value.toString();
  final buffer = StringBuffer();
  for (var index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 == 0) {
      buffer.write(',');
    }
    buffer.write(digits[index]);
  }
  return buffer.toString();
}

String _resetSuffix(DateTime? resetsAt) {
  if (resetsAt == null) {
    return '';
  }
  // The server decides when the period turns over, so the date comes from it
  // rather than from the device's idea of the month.
  final local = resetsAt.toLocal();
  return ' · resets ${local.day}/${local.month}';
}
