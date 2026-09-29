import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart' show formatCredits;

/// The pieces a credit-log row is drawn from: the row itself, the sticky day
/// heading above a group of them, and the words and icons both are built with.

/// How an entry moved the balance, in the reader's terms. Drives the tone of
/// its icon and amount; the sign, the words and the badge say the same thing so
/// the tone is never the only signal.
enum CreditFlow { added, spent, held, refunded, expired }

CreditFlow creditFlowOf(CreditLogEntry entry) {
  if (entry.refunded) return CreditFlow.refunded;
  if (entry.kind == CreditLogKind.expired) return CreditFlow.expired;
  if (entry.pending && !entry.addsCredits) return CreditFlow.held;
  return entry.addsCredits ? CreditFlow.added : CreditFlow.spent;
}

class CreditLogTile extends StatelessWidget {
  const CreditLogTile({required this.entry, super.key});

  final CreditLogEntry entry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final flow = creditFlowOf(entry);
    // A refunded charge left the balance exactly as it found it, so it is drawn
    // as history rather than as money moved.
    final muted = flow == CreditFlow.refunded || flow == CreditFlow.expired;
    final amountColor = muted
        ? colors.onSurfaceVariant
        : flow == CreditFlow.added
        ? colors.primary
        : colors.onSurface;
    final iconFill = flow == CreditFlow.added
        ? colors.primaryContainer
        : colors.surfaceContainerHigh;
    final iconColor = flow == CreditFlow.added
        ? colors.onPrimaryContainer
        : colors.onSurfaceVariant;

    final localizations = MaterialLocalizations.of(context);
    final time = localizations.formatTimeOfDay(
      TimeOfDay.fromDateTime(entry.createdAt.toLocal()),
      alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
    );
    final detail = <String>[
      if (entry.projectTitle != null && entry.projectTitle!.isNotEmpty)
        entry.projectTitle!,
      time,
    ].join(' · ');

    return Semantics(
      container: true,
      label: creditLogSemanticLabel(entry),
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DecoratedBox(
                decoration: BoxDecoration(
                  color: iconFill,
                  borderRadius: BorderRadius.circular(AppRadii.control - 2),
                ),
                child: SizedBox.square(
                  dimension: 40,
                  child: Icon(
                    creditLogIconFor(entry),
                    size: 20,
                    color: iconColor,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.title,
                      style: text.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: muted ? colors.onSurfaceVariant : null,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      detail,
                      style: text.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    if (entry.pending || entry.refunded) ...[
                      const SizedBox(height: 6),
                      AppStatusBadge(
                        label: entry.refunded ? 'Refunded' : 'On hold',
                        icon: entry.refunded
                            ? Icons.undo
                            : Icons.hourglass_bottom,
                        tone: entry.refunded
                            ? AppTone.success
                            : AppTone.warning,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  creditLogAmountLabel(entry),
                  maxLines: 1,
                  softWrap: false,
                  style: text.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: amountColor,
                    decoration: entry.refunded
                        ? TextDecoration.lineThrough
                        : null,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The day a group of entries belongs to, pinned under the filter bar until the
/// next day's heading pushes it off.
class CreditLogDayHeader extends SliverPersistentHeaderDelegate {
  CreditLogDayHeader({
    required this.label,
    required this.extent,
    required this.background,
  });

  final String label;
  final double extent;
  final Color background;

  @override
  double get minExtent => extent;

  @override
  double get maxExtent => extent;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        border: Border(
          bottom: BorderSide(
            color: overlapsContent ? colors.outlineVariant : Colors.transparent,
          ),
        ),
      ),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Semantics(
          header: true,
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.3,
            ),
          ),
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant CreditLogDayHeader oldDelegate) =>
      label != oldDelegate.label ||
      extent != oldDelegate.extent ||
      background != oldDelegate.background;
}

/// Placeholders shaped like the list, so the first load already shows where
/// things will be.
class CreditLogSkeleton extends StatelessWidget {
  const CreditLogSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget bar(double width, double height) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.compact),
      ),
    );
    return Semantics(
      label: 'Loading your credit history',
      liveRegion: true,
      child: ExcludeSemantics(
        child: AppShimmer(
          child: ListView(
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            children: [
              bar(64, 14),
              const SizedBox(height: AppSpacing.sm),
              for (var index = 0; index < 7; index += 1) ...[
                if (index == 3) ...[
                  const SizedBox(height: AppSpacing.md),
                  bar(88, 14),
                  const SizedBox(height: AppSpacing.sm),
                ],
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: [
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: colors.surfaceContainerHigh,
                          borderRadius: BorderRadius.circular(
                            AppRadii.control - 2,
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            bar(index.isEven ? 150 : 120, 14),
                            const SizedBox(height: 8),
                            bar(90, 11),
                          ],
                        ),
                      ),
                      bar(48, 18),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

String creditLogAmountLabel(CreditLogEntry entry) {
  return '${entry.addsCredits ? '+' : '-'}${formatCredits(entry.credits)}';
}

/// The icon for a kind of movement. [creditLogIconFor] refines it by what the
/// credits were spent on.
IconData creditLogIcon(CreditLogKind kind) {
  return switch (kind) {
    CreditLogKind.purchase => Icons.add_card_outlined,
    CreditLogKind.subscription => Icons.workspace_premium_outlined,
    CreditLogKind.monthly => Icons.event_repeat_outlined,
    CreditLogKind.bonus => Icons.card_giftcard_outlined,
    CreditLogKind.refund => Icons.undo,
    CreditLogKind.expired => Icons.timer_off_outlined,
    CreditLogKind.spend => Icons.auto_stories_outlined,
  };
}

/// A spend is drawn with the icon of what it bought.
///
/// The server sends a plain-language title for every charge ("Illustration",
/// "Audiobook", "Book edit"), and that is the only field that says what a spend
/// was for, so the icon reads it. A title this does not recognise — or a new
/// one the server adds — simply falls back to the kind's own icon.
IconData creditLogIconFor(CreditLogEntry entry) {
  if (entry.kind != CreditLogKind.spend) {
    return creditLogIcon(entry.kind);
  }
  final title = entry.title.toLowerCase();
  bool has(String word) => title.contains(word);
  if (has('illustration') || has('cover') || has('portrait') || has('image')) {
    return Icons.image_outlined;
  }
  if (has('audiobook') || has('narrat')) return Icons.headphones_outlined;
  if (has('call')) return Icons.call_outlined;
  if (has('chat') || has('message')) return Icons.chat_bubble_outline_rounded;
  if (has('export')) return Icons.file_download_outlined;
  if (has('edit') || has('rewrite') || has('revision')) {
    return Icons.edit_outlined;
  }
  if (has('review')) return Icons.rate_review_outlined;
  if (has('plan')) return Icons.map_outlined;
  return creditLogIcon(entry.kind);
}

/// Screen readers get the sign spelled out — a leading `+` or `-` is announced
/// inconsistently, and this is the one number on the screen that must be exact.
String creditLogSemanticLabel(CreditLogEntry entry) {
  final credits = '${formatCredits(entry.credits)} credits';
  final movement = entry.refunded
      ? '$credits refunded'
      : entry.addsCredits
      ? '$credits added'
      : entry.pending
      ? '$credits on hold'
      : '$credits used';
  final book = entry.projectTitle;
  return [
    entry.title,
    movement,
    if (book != null && book.isNotEmpty) book,
    timeLabelFor(entry.createdAt),
  ].join(', ');
}

/// Days are named where a name is clearer than a date. Older days are dated in
/// the reader's own locale when [localizations] is given, and in `d/m/y` order
/// otherwise.
String dayLabelFor(
  DateTime value,
  DateTime now, {
  MaterialLocalizations? localizations,
}) {
  final local = value.toLocal();
  final day = DateTime(local.year, local.month, local.day);
  final today = DateTime(now.year, now.month, now.day);
  final difference = today.difference(day).inDays;
  return switch (difference) {
    0 => 'Today',
    1 => 'Yesterday',
    _ =>
      localizations == null
          ? '${day.day}/${day.month}/${day.year}'
          : localizations.formatMediumDate(day),
  };
}

String timeLabelFor(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}
