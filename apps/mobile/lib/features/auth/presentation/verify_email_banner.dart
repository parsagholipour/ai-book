import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import 'verify_email_location.dart';

/// "Verify your email to get your … free credits", with a way there and a
/// way to say not now. Draws nothing unless the billing payload says the
/// welcome grant is waiting on this reader's email — so an account already
/// welcomed, one whose address already received its share, a server that
/// predates verification, and an offline start all see nothing.
class VerifyEmailBanner extends ConsumerWidget {
  const VerifyEmailBanner({
    this.padding = const EdgeInsets.fromLTRB(18, 12, 18, 0),
    super.key,
  });

  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(verifyEmailBannerDismissedProvider)) {
      return const SizedBox.shrink();
    }
    final line = verifyEmailCreditsLine(
      ref.watch(billingProvider).asData?.value,
    );
    if (line == null) return const SizedBox.shrink();
    return Padding(
      padding: padding,
      child: AppInlineNotice(
        key: const ValueKey('verify-email-banner'),
        icon: Icons.mark_email_unread_outlined,
        tone: AppTone.info,
        title: 'Your free credits are waiting',
        message: line,
        actionLabel: 'Verify email',
        onAction: () => openVerifyEmail(context),
        onDismiss: () =>
            ref.read(verifyEmailBannerDismissedProvider.notifier).dismiss(),
      ),
    );
  }
}

/// Opens the verify screen from wherever the reader is. Asked from inside a
/// sheet — a paywall, the message allowance — the sheet closes first, so the
/// code screen is not stacked over a price list and coming back lands on the
/// page the sheet was opened over, which reads the refreshed balance.
void openVerifyEmail(BuildContext context) {
  final router = GoRouter.maybeOf(context);
  if (ModalRoute.of(context) is PopupRoute) {
    Navigator.of(context).pop();
  }
  router?.push(verifyEmailLocation());
}

/// What a surface that asks for credits shows first while the welcome grant
/// waits on this reader's email: verifying is free and pays more than any
/// shortfall it is drawn over, so it comes before every price — and the
/// prices stay below it for anyone who would rather pay. Not dismissible: it
/// is the cheapest way out of the shortfall, and it goes on its own once the
/// grant settles. Draws nothing when nothing waits on verification.
class VerifyEmailCreditsLead extends StatelessWidget {
  const VerifyEmailCreditsLead({
    required this.billing,
    this.padding = EdgeInsets.zero,
    super.key,
  });

  final MobileBilling? billing;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final line = verifyEmailCreditsLine(billing);
    if (line == null) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    final tone = appToneColors(context, AppTone.info);
    return Padding(
      padding: padding,
      child: Semantics(
        container: true,
        child: DecoratedBox(
          key: const ValueKey('verify-email-credits-lead'),
          decoration: BoxDecoration(
            color: tone.background,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ExcludeSemantics(
                      child: Icon(
                        Icons.mark_email_unread_outlined,
                        color: tone.foreground,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        line,
                        style: text.titleSmall?.copyWith(
                          color: tone.foreground,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  'Enter the code we emailed you. It costs nothing, and '
                  'buying credits is still below.',
                  style: text.bodySmall?.copyWith(color: tone.foreground),
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton.primary(
                  onPressed: () => openVerifyEmail(context),
                  leading: const Icon(Icons.verified_outlined),
                  label: 'Verify email',
                  expanded: true,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
