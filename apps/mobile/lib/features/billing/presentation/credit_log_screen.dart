import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../data/credit_log_repository.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart' show formatCredits;

/// Where the credits went, newest first.
///
/// The list is paged rather than capped: the answer to "why is my balance low"
/// is often a fortnight back, and a screen that stops at the last twenty entries
/// cannot give it. Paging is by entry id, so credits landing while the reader
/// scrolls cannot shift the page under them.
class CreditLogScreen extends ConsumerStatefulWidget {
  const CreditLogScreen({super.key});

  @override
  ConsumerState<CreditLogScreen> createState() => _CreditLogScreenState();
}

const _pageSize = 30;

class _CreditLogScreenState extends ConsumerState<CreditLogScreen> {
  final _entries = <CreditLogEntry>[];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  String? _moreError;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _loading = true;
      _error = null;
      _moreError = null;
    });
    try {
      final page = await ref
          .read(creditLogRepositoryProvider)
          .getCreditLog(limit: _pageSize);
      if (!mounted) {
        return;
      }
      setState(() {
        _entries
          ..clear()
          ..addAll(page.entries);
        _cursor = page.nextCursor;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = userFacingError(error);
        _loading = false;
      });
    }
  }

  /// A failed page keeps everything already loaded and offers a retry: losing
  /// the reader's place because the last request timed out is its own bug.
  Future<void> _loadMore() async {
    final cursor = _cursor;
    if (cursor == null || _loading || _loadingMore || _moreError != null) {
      return;
    }
    setState(() => _loadingMore = true);
    try {
      final page = await ref
          .read(creditLogRepositoryProvider)
          .getCreditLog(cursor: cursor, limit: _pageSize);
      if (!mounted) {
        return;
      }
      setState(() {
        _entries.addAll(page.entries);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _moreError = userFacingError(error);
        _loadingMore = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Credit log')),
      body: RefreshIndicator(
        onRefresh: _loadFirstPage,
        child: _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const AppLoadingState(message: 'Loading your credit history');
    }
    if (_error != null) {
      return ListView(
        padding: const EdgeInsets.only(top: 24),
        children: [
          AppErrorState(
            title: 'Could not load your credit log',
            message: _error!,
            onRetry: _loadFirstPage,
          ),
        ],
      );
    }
    if (_entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.only(top: 24),
        children: const [
          AppEmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'No credit history yet',
            message:
                'Credits you buy, and the ones your books use, will be listed here.',
          ),
        ],
      );
    }

    final rows = _rows(_entries);
    // The trailing row is the loader, the retry, or the end of the history.
    final itemCount = rows.length + 1;
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
      itemCount: itemCount,
      itemBuilder: (context, index) {
        if (index == rows.length) {
          return _trailing(context);
        }
        return switch (rows[index]) {
          _DayRow(:final label) => _DayHeader(label: label, first: index == 0),
          _EntryRow(:final entry) => _CreditLogTile(entry: entry),
        };
      },
    );
  }

  Widget _trailing(BuildContext context) {
    if (_moreError != null) {
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: AppInlineNotice(
          icon: Icons.wifi_off_outlined,
          title: 'Could not load older entries',
          message: _moreError!,
          tone: AppNoticeTone.warning,
          actionLabel: 'Try again',
          onAction: () {
            setState(() => _moreError = null);
            _loadMore();
          },
        ),
      );
    }
    if (_cursor != null) {
      // Building this row means it has scrolled into reach, which is the signal
      // to fetch the next page. The guard in `_loadMore` keeps it to one.
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadMore());
      return const Padding(
        padding: EdgeInsets.only(top: 8),
        child: AppLoadingState(message: 'Loading older entries'),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Text(
        'Work that fails is refunded automatically, so a refund can follow a '
        'charge by a few minutes.',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// One line of the list: a day heading, or an entry under it.
sealed class _LogRow {
  const _LogRow();
}

class _DayRow extends _LogRow {
  const _DayRow(this.label);

  final String label;
}

class _EntryRow extends _LogRow {
  const _EntryRow(this.entry);

  final CreditLogEntry entry;
}

List<_LogRow> _rows(List<CreditLogEntry> entries) {
  final now = DateTime.now();
  final rows = <_LogRow>[];
  String? currentDay;
  for (final entry in entries) {
    final day = dayLabelFor(entry.createdAt, now);
    if (day != currentDay) {
      currentDay = day;
      rows.add(_DayRow(day));
    }
    rows.add(_EntryRow(entry));
  }
  return rows;
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.label, required this.first});

  final String label;
  final bool first;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: first ? 8 : 20, bottom: 8),
      child: Semantics(
        header: true,
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelLarge?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.3,
          ),
        ),
      ),
    );
  }
}

class _CreditLogTile extends StatelessWidget {
  const _CreditLogTile({required this.entry});

  final CreditLogEntry entry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    // A refunded charge left the balance exactly as it found it, so it is drawn
    // as history rather than as money moved.
    final muted = entry.refunded;
    final amountColor = muted
        ? colors.onSurfaceVariant
        : entry.addsCredits
        ? colors.primary
        : colors.onSurface;

    final detail = <String>[
      if (entry.projectTitle != null && entry.projectTitle!.isNotEmpty)
        entry.projectTitle!,
      timeLabelFor(entry.createdAt),
    ].join(' · ');

    return Semantics(
      container: true,
      label: creditLogSemanticLabel(entry),
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  creditLogIcon(entry.kind),
                  size: 19,
                  color: entry.addsCredits && !muted
                      ? colors.primary
                      : colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.title,
                      style: text.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
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
                            ? AppNoticeTone.success
                            : AppNoticeTone.warning,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  creditLogAmountLabel(entry),
                  style: text.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: amountColor,
                    decoration: muted ? TextDecoration.lineThrough : null,
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

String creditLogAmountLabel(CreditLogEntry entry) {
  return '${entry.addsCredits ? '+' : '-'}${formatCredits(entry.credits)}';
}

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

/// Days are named where a name is clearer than a date, and dated otherwise —
/// in the same `d/m/y` order the account screen uses.
String dayLabelFor(DateTime value, DateTime now) {
  final local = value.toLocal();
  final day = DateTime(local.year, local.month, local.day);
  final today = DateTime(now.year, now.month, now.day);
  final difference = today.difference(day).inDays;
  return switch (difference) {
    0 => 'Today',
    1 => 'Yesterday',
    _ => '${day.day}/${day.month}/${day.year}',
  };
}

String timeLabelFor(DateTime value) {
  final local = value.toLocal();
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}
