import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';

// The credit price of a chat action, shown as a small badge instead of a
// sentence in the reply. Chat used to say "This uses 800 credits." in every
// priced message, which put an accounting figure in the middle of the writing
// conversation. The number is the same, it just sits in the corner now and
// explains itself when tapped.

/// What the number on a badge means. The same figure is a quote before Apply,
/// a charge once the work is queued, and a reversal when it failed — and the
/// explanation has to say which, or a refunded charge reads as money lost.
enum CreditCostKind { quoted, charged, refunded }

class CreditCostBadge extends StatelessWidget {
  const CreditCostBadge({
    required this.credits,
    this.kind = CreditCostKind.charged,
    this.foreground,
    super.key,
  });

  final int credits;
  final CreditCostKind kind;

  /// Set when the badge sits on a tinted surface (an operation card) so it
  /// keeps its contrast there.
  final Color? foreground;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final tint = foreground ?? colors.onSurfaceVariant;
    final refunded = kind == CreditCostKind.refunded;
    return Semantics(
      button: true,
      label: _semanticLabel(credits, kind),
      child: ExcludeSemantics(
        child: Material(
          color: tint.withValues(alpha: 0.10),
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () =>
                showCreditCostSheet(context, credits: credits, kind: kind),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    refunded ? Icons.undo : Icons.toll_outlined,
                    size: 14,
                    color: tint,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '$credits',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: tint,
                      fontWeight: FontWeight.w700,
                      decoration: refunded ? TextDecoration.lineThrough : null,
                      decorationColor: tint,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String _semanticLabel(int credits, CreditCostKind kind) {
  final amount = '$credits credits';
  return switch (kind) {
    CreditCostKind.quoted => '$amount. Tap to learn what this costs.',
    CreditCostKind.charged => '$amount used. Tap to learn what this paid for.',
    CreditCostKind.refunded => '$amount refunded. Tap for details.',
  };
}

Future<void> showCreditCostSheet(
  BuildContext context, {
  required int credits,
  CreditCostKind kind = CreditCostKind.charged,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (_) => CreditCostSheet(credits: credits, kind: kind),
  );
}

class CreditCostSheet extends ConsumerWidget {
  const CreditCostSheet({
    required this.credits,
    this.kind = CreditCostKind.charged,
    super.key,
  });

  final int credits;
  final CreditCostKind kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // Absent while the balance loads, and after a failure. Neither is worth an
    // error state in a sheet that is only here to explain a number.
    final available = ref
        .watch(billingProvider)
        .asData
        ?.value
        .credits
        .available;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: colors.primaryContainer,
                    borderRadius: BorderRadius.circular(TomezaRadii.control),
                  ),
                  child: Icon(
                    Icons.toll_outlined,
                    color: colors.onPrimaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '$credits credits',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      Text(
                        _headline(kind),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            const _CreditFact(
              icon: Icons.auto_stories_outlined,
              title: 'Credits pay for the writing',
              body:
                  'Every change runs the book through the AI again — the prose, '
                  'the pictures it touches, and the PDF and EPUB it rebuilds '
                  'afterwards. Credits are how that work is paid for.',
            ),
            const SizedBox(height: 14),
            const _CreditFact(
              icon: Icons.straighten_outlined,
              title: 'Bigger changes cost more',
              body:
                  'One page is priced as one page. Rewriting a chapter, '
                  'continuing the story or rebuilding the whole book costs more '
                  'because there is more to write.',
            ),
            const SizedBox(height: 14),
            const _CreditFact(
              icon: Icons.replay_outlined,
              title: 'Failed updates are refunded',
              body:
                  'If an update cannot finish, its credits go back to your '
                  'balance on their own. You are never charged for a change you '
                  'did not get.',
            ),
            if (available != null) ...[
              const SizedBox(height: 20),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(TomezaRadii.card),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.account_balance_wallet_outlined,
                      size: 20,
                      color: colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'You have $available credits.',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                    TextButton(
                      onPressed: () {
                        // The paywall replaces this sheet, so it has to be
                        // opened from the navigator's own context: ours is
                        // gone the moment the sheet pops.
                        final navigator = Navigator.of(context);
                        navigator.pop();
                        showBillingPaywall(
                          navigator.context,
                          title: 'Add credits',
                        );
                      },
                      child: const Text('Add credits'),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Got it'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _headline(CreditCostKind kind) {
  return switch (kind) {
    CreditCostKind.quoted => 'What this edit will cost if you apply it.',
    CreditCostKind.charged => 'Taken from your balance for this update.',
    CreditCostKind.refunded => 'Returned to your balance — this update failed.',
  };
}

class _CreditFact extends StatelessWidget {
  const _CreditFact({
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: colors.primary),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                body,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
