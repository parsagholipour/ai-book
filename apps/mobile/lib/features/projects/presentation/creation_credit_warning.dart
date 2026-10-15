import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/presentation/verify_email_banner.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/creation_prefs_store.dart';
import '../domain/creation_credit_budget.dart';
import '../domain/creation_models.dart';

/// Checks the final image choices and current balance before planning is paid.
/// Null abandons this build without committing its page-count selection.
Future<int?> confirmCreationCredits(
  BuildContext context,
  WidgetRef ref, {
  required MobileCreationPresets presets,
  required int targetPages,
}) async {
  final store = ref.read(creationPrefsStoreProvider);
  final prefs = await store.load();
  if (!context.mounted) return null;
  if (prefs.creditWarningSuppressed) return targetPages;

  final billing = await ref.refresh(billingProvider.future);
  if (!context.mounted) return null;
  final affordablePages = affordableCreationPages(
    presets: presets,
    targetPages: targetPages,
    availableCredits: billing.credits.available,
    creditCosts: billing.creditCosts,
  );
  if (affordablePages >= targetPages) return targetPages;

  final choice = await showDialog<_CreditWarningChoice>(
    context: context,
    builder: (_) => _CreationCreditWarning(
      affordablePages: affordablePages,
      billing: billing,
    ),
  );
  if (choice == null) return null;
  if (choice.dontShowAgain) {
    await store.save(prefs.copyWith(creditWarningSuppressed: true));
  }
  if (affordablePages == 0) {
    return choice.confirmed ? targetPages : null;
  }
  return choice.confirmed ? affordablePages : targetPages;
}

typedef _CreditWarningChoice = ({bool confirmed, bool dontShowAgain});

class _CreationCreditWarning extends StatefulWidget {
  const _CreationCreditWarning({
    required this.affordablePages,
    required this.billing,
  });

  final int affordablePages;

  /// Read for the welcome grant: while it waits on this reader's email, the
  /// free way to the credits leads the warning. Verify closes it, which
  /// abandons this build.
  final MobileBilling billing;

  @override
  State<_CreationCreditWarning> createState() => _CreationCreditWarningState();
}

class _CreationCreditWarningState extends State<_CreationCreditWarning> {
  bool _dontShowAgain = false;

  void _answer(bool confirmed) => Navigator.of(
    context,
  ).pop((confirmed: confirmed, dontShowAgain: _dontShowAgain));

  @override
  Widget build(BuildContext context) {
    final pages = widget.affordablePages;
    final pageLabel = pages == 1 ? '1 page' : '$pages pages';
    return AlertDialog(
      title: Text(pages > 0 ? 'Reduce the page count?' : 'Not enough credits'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            VerifyEmailCreditsLead(
              billing: widget.billing,
              padding: const EdgeInsets.only(bottom: 12),
            ),
            Text(
              pages > 0
                  ? 'With your current credits, you can make up to $pageLabel '
                        'with these settings, including the cost of planning. '
                        'Do you want to reduce the page count to $pages?'
                  : 'Your current credits cannot cover even a 1-page book '
                        'with these settings, including the cost of planning. '
                        'You will need more credits or different settings to '
                        'make the book. Do you want to build the plan anyway?',
            ),
            const SizedBox(height: 12),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _dontShowAgain,
              onChanged: (value) =>
                  setState(() => _dontShowAgain = value ?? false),
              title: const Text("Don't show again"),
            ),
          ],
        ),
      ),
      actions: [
        AppButton.text(onPressed: () => _answer(false), label: 'No'),
        AppButton.primary(onPressed: () => _answer(true), label: 'Yes'),
      ],
    );
  }
}
