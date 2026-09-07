import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';

class BillingExportHero extends StatelessWidget {
  const BillingExportHero({
    required this.format,
    required this.onClose,
    super.key,
  });

  final String format;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'MAKE IT YOURS',
                style: text.labelSmall?.copyWith(
                  color: colors.primary,
                  letterSpacing: 1.8,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            IconButton(
              tooltip: 'Close',
              onPressed: onClose,
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
        Row(
          children: [
            Expanded(
              child: Text(
                'Your book.\nReady for $format.',
                style: text.headlineMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  height: 1.1,
                  letterSpacing: -0.7,
                ),
              ),
            ),
            const SizedBox(width: 12),
            ExcludeSemantics(
              child: Transform.rotate(
                angle: 0.08,
                child: Container(
                  width: 62,
                  height: 76,
                  decoration: BoxDecoration(
                    color: colors.tertiaryContainer,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(
                      color: colors.tertiary.withValues(alpha: 0.2),
                    ),
                  ),
                  child: Icon(
                    Icons.description_outlined,
                    size: 36,
                    color: colors.onTertiaryContainer,
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          format == 'Word'
              ? 'Edit every chapter, share with your editor, and make the final draft your own.'
              : 'Take your book further with $format export and more room to create.',
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
      ],
    );
  }
}

class BillingExportOfferDetails extends StatelessWidget {
  const BillingExportOfferDetails({
    required this.format,
    required this.freeTier,
    required this.isFree,
    required this.onClose,
    super.key,
  });

  final String format;
  final MobileFreeTier freeTier;
  final bool isFree;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.card),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'More than an export',
                style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 14),
              _Benefit(
                icon: Icons.edit_document,
                title: format == 'Word'
                    ? 'A manuscript you can edit'
                    : '$format export included',
                description: format == 'Word'
                    ? 'Download your book as an editable .docx file.'
                    : 'Download and share your book in $format.',
              ),
              const SizedBox(height: 14),
              const _Benefit(
                icon: Icons.auto_stories_outlined,
                title: 'Keep your next book moving',
                description:
                    'Monthly credits for writing, edits, and illustrations.',
              ),
              const SizedBox(height: 14),
              const _Benefit(
                icon: Icons.upload_file_outlined,
                title: 'Bring your own manuscript',
                description: 'Import an existing draft and build on it.',
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: 16),
          title: Text('How do credits work?', style: text.titleSmall),
          children: [
            Text(
              'Your plan adds credits each month. Writing, editing, illustrations, '
              'and export unlocks use credits. The amount depends on your book '
              'and settings. Monthly credits reset each billing period; credits '
              'bought separately never expire. Paid plans also remove the monthly '
              'illustrated-book limit; creating illustrations still uses credits.',
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
        ),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: 16),
          title: Text('What happens if I cancel?', style: text.titleSmall),
          children: [
            Text(
              'Cancel in Google Play anytime. Your plan stays active until the '
              'end of the paid period, then your account returns to Free. '
              'Your books and files you have already downloaded stay yours.',
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
        ),
        if (isFree) ...[
          const SizedBox(height: 12),
          Text(
            'Free includes ${formatCredits(freeTier.monthlyCredits)} credits and '
            '${freeTier.illustratedBooksPerMonth} illustrated books each month. '
            '$format export requires a paid plan.',
            textAlign: TextAlign.center,
            style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          Center(
            child: AppButton.text(onPressed: onClose, label: 'Keep Free'),
          ),
        ],
      ],
    );
  }
}

class _Benefit extends StatelessWidget {
  const _Benefit({
    required this.icon,
    required this.title,
    required this.description,
  });

  final IconData icon;
  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: colors.primary, size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                description,
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
