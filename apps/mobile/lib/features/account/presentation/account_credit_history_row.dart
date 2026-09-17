import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';

class AccountCreditHistoryRow extends StatelessWidget {
  const AccountCreditHistoryRow({super.key});

  @override
  Widget build(BuildContext context) {
    return AppSettingsRow(
      icon: Icons.receipt_long_outlined,
      title: 'Credit history',
      onTap: () => context.push('/account/credit-history'),
    );
  }
}
