import 'package:flutter/material.dart';

import 'billing_controller.dart';

Future<void> showBillingPurchaseSuccessDialog(
  BuildContext context,
  BillingPurchaseSuccess purchase,
) {
  return showDialog<void>(
    context: context,
    builder: (context) => BillingPurchaseSuccessDialog(purchase: purchase),
  );
}

class BillingPurchaseSuccessDialog extends StatelessWidget {
  const BillingPurchaseSuccessDialog({required this.purchase, super.key});

  final BillingPurchaseSuccess purchase;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AlertDialog(
      key: const ValueKey('billing-purchase-success-dialog'),
      icon: Icon(Icons.check_circle_rounded, color: colors.primary, size: 40),
      title: const Text('Purchase successful'),
      content: Text(purchase.message),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
