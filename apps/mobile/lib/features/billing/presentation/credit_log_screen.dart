import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../data/credit_log_repository.dart';
import '../domain/billing_models.dart';
import 'credit_log_tile.dart';

export 'credit_log_tile.dart'
    show
        creditLogAmountLabel,
        creditLogIcon,
        creditLogIconFor,
        creditLogSemanticLabel,
        dayLabelFor,
        timeLabelFor;

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

/// Which movements the list shows. It filters what has been loaded; the
/// screen keeps paging in older entries while a filter still has none to show,
/// so a filter never claims there is nothing when the answer is further back.
enum _LogFilter {
  all('All'),
  spent('Spent'),
  added('Added');

  const _LogFilter(this.label);

  final String label;

  bool admits(CreditLogEntry entry) => switch (this) {
    _LogFilter.all => true,
    _LogFilter.spent => !entry.addsCredits,
    _LogFilter.added => entry.addsCredits,
  };
}

class _CreditLogScreenState extends ConsumerState<CreditLogScreen> {
  final _entries = <CreditLogEntry>[];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  String? _moreError;
  _LogFilter _filter = _LogFilter.all;

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

  void _choose(_LogFilter filter) {
    if (filter == _filter) return;
    AppHaptics.selection();
    setState(() => _filter = filter);
  }

  @override
  Widget build(BuildContext context) {
    final showFilters = !_loading && _error == null && _entries.isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('Credit history')),
      body: Column(
        children: [
          if (showFilters) _FilterBar(selected: _filter, onSelected: _choose),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _loadFirstPage,
              child: _body(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const CreditLogSkeleton();
    }
    if (_error != null) {
      return _scrollable(
        AppErrorState(
          title: 'Could not load your credit history',
          message: _error!,
          onRetry: _loadFirstPage,
        ),
      );
    }
    if (_entries.isEmpty) {
      return _scrollable(
        const AppEmptyState(
          icon: Icons.receipt_long_outlined,
          title: 'No credit history yet',
          message:
              'Credits you get, and the ones your books use, will be listed here.',
        ),
      );
    }

    final visible = _entries.where(_filter.admits).toList();
    if (visible.isEmpty && _cursor == null) {
      return _scrollable(
        AppEmptyState(
          icon: Icons.filter_alt_off_outlined,
          title: _filter == _LogFilter.spent
              ? 'No credits spent yet'
              : 'No credits added yet',
          message: 'Nothing in your history matches this filter.',
          actionLabel: 'Show everything',
          onAction: () => _choose(_LogFilter.all),
        ),
      );
    }

    final surface = Theme.of(context).colorScheme.surface;
    final headerExtent = MediaQuery.textScalerOf(context).scale(20) + 22;
    final localizations = MaterialLocalizations.of(context);
    final now = DateTime.now();
    final groups = <(String, List<CreditLogEntry>)>[];
    for (final entry in visible) {
      final day = dayLabelFor(
        entry.createdAt,
        now,
        localizations: localizations,
      );
      if (groups.isEmpty || groups.last.$1 != day) {
        groups.add((day, [entry]));
      } else {
        groups.last.$2.add(entry);
      }
    }

    return CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        for (final (index, group) in groups.indexed)
          SliverPadding(
            padding: EdgeInsets.fromLTRB(
              16,
              0,
              16,
              index == groups.length - 1 ? 28 : 0,
            ),
            // A group per day, so each heading sticks only while its own day
            // is on screen and the next one takes its place.
            sliver: SliverMainAxisGroup(
              slivers: [
                SliverPersistentHeader(
                  pinned: true,
                  delegate: CreditLogDayHeader(
                    label: group.$1,
                    extent: headerExtent,
                    background: surface,
                  ),
                ),
                // The last group carries the trailing row as its last item: a
                // list only builds what is in reach, and building that row is
                // the signal to fetch the next page.
                SliverList.builder(
                  itemCount:
                      group.$2.length + (index == groups.length - 1 ? 1 : 0),
                  itemBuilder: (context, item) => item == group.$2.length
                      ? _trailing(context)
                      : CreditLogTile(entry: group.$2[item]),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// Pull-to-refresh needs something scrollable even when there is nothing to
  /// list, so states that are not a list still scroll.
  Widget _scrollable(Widget child) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(top: 24),
      children: [child],
    );
  }

  /// The trailing row is the loader, the retry, or the end of the history.
  Widget _trailing(BuildContext context) {
    if (_moreError != null) {
      return AppInlineNotice(
        icon: Icons.wifi_off_outlined,
        title: 'Could not load older entries',
        message: _moreError!,
        tone: AppTone.warning,
        actionLabel: 'Try again',
        onAction: () {
          setState(() => _moreError = null);
          _loadMore();
        },
      );
    }
    if (_cursor != null) {
      // Building this row means it has scrolled into reach, which is the signal
      // to fetch the next page. The guard in `_loadMore` keeps it to one.
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadMore());
      return const _LoadingOlder();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
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

/// The pagination indicator: small, at the foot of the list, and named for a
/// screen reader.
class _LoadingOlder extends StatelessWidget {
  const _LoadingOlder();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: 'Loading older entries',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(
                'Loading older entries',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// All / Spent / Added, above the list rather than in it so the filter stays
/// reachable however far down the history the reader has gone.
class _FilterBar extends StatelessWidget {
  const _FilterBar({required this.selected, required this.onSelected});

  final _LogFilter selected;
  final ValueChanged<_LogFilter> onSelected;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        child: Wrap(
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xxs,
          children: [
            for (final filter in _LogFilter.values)
              FilterChip(
                key: ValueKey('credit-log-filter-${filter.name}'),
                label: Text(filter.label),
                selected: filter == selected,
                showCheckmark: true,
                onSelected: (_) => onSelected(filter),
              ),
          ],
        ),
      ),
    );
  }
}
