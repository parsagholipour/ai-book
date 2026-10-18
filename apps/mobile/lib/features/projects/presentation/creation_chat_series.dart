part of 'creation_chat_screen.dart';

// The series offer: once a character the reader @-mentions already appears in
// one of their finished books, the chat asks whether this book continues that
// one, is a new story in its world, or is a story of its own. The server
// derives the offer (`apps/api/src/mobile/creationSeries.ts`) and stores only
// the answer, so this strip draws whatever the session says, and the answer
// changes nothing until Build copies the earlier book into the new one.
//
// One strip, three shapes: the open question, a one-line reminder of the
// answer with a way to change it, or nothing. Never a dead end: every shape
// either asks, says what was decided, or is absent.

class _SeriesStrip extends ConsumerStatefulWidget {
  const _SeriesStrip({
    required this.series,
    required this.pending,
    required this.busy,
    super.key,
  });

  final MobileCreationSeries? series;

  /// A "Write the next book" link chosen before the session exists.
  final PendingBookSeries? pending;
  final bool busy;

  @override
  ConsumerState<_SeriesStrip> createState() => _SeriesStripState();
}

class _SeriesStripState extends ConsumerState<_SeriesStrip> {
  bool _editing = false;
  int _selected = 0;

  /// The books to offer: the server's, or else the one already chosen, so
  /// Change always has the linked book to show.
  List<MobileCreationSeriesBook> get _books {
    final books = widget.series?.books ?? const <MobileCreationSeriesBook>[];
    final choice = _choice;
    final projectId = choice?.projectId;
    if (books.isNotEmpty || projectId == null || !choice!.mode.linksBook) {
      return books;
    }
    return [
      MobileCreationSeriesBook(projectId: projectId, title: choice.title ?? ''),
    ];
  }

  MobileCreationSeriesChoice? get _choice {
    final pending = widget.pending;
    return widget.series?.choice ??
        (pending == null
            ? null
            : MobileCreationSeriesChoice(
                mode: pending.mode,
                projectId: pending.projectId,
                title: pending.title,
              ));
  }

  Future<void> _choose(BookSeriesMode mode) async {
    final books = _books;
    final book = books.isEmpty
        ? null
        : books[_selected.clamp(0, books.length - 1)];
    try {
      await ref
          .read(creationChatControllerProvider.notifier)
          .chooseSeries(mode, book: book);
      if (mounted) setState(() => _editing = false);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final books = _books;
    final choice = _choice;
    final asking = (choice == null && books.isNotEmpty) || _editing;
    return AnimatedSize(
      duration: AppMotion.fast,
      alignment: Alignment.bottomCenter,
      child: asking && books.isNotEmpty
          ? _SeriesOfferCard(
              key: const ValueKey('series-offer'),
              books: books,
              selected: _selected.clamp(0, books.length - 1),
              busy: widget.busy,
              onSelect: (index) => setState(() => _selected = index),
              onChoose: (mode) => unawaited(_choose(mode)),
              onClose: _editing ? () => setState(() => _editing = false) : null,
            )
          : choice != null && (choice.mode.linksBook || books.isNotEmpty)
          ? _SeriesChoiceRow(
              key: const ValueKey('series-choice'),
              choice: choice,
              busy: widget.busy,
              onChange: () => setState(() {
                _editing = true;
                final index = books.indexWhere(
                  (book) => book.projectId == choice.projectId,
                );
                _selected = index < 0 ? 0 : index;
              }),
            )
          : const SizedBox.shrink(),
    );
  }
}

/// The open question, with the books to choose from and the three answers.
class _SeriesOfferCard extends StatelessWidget {
  const _SeriesOfferCard({
    required this.books,
    required this.selected,
    required this.busy,
    required this.onSelect,
    required this.onChoose,
    this.onClose,
    super.key,
  });

  final List<MobileCreationSeriesBook> books;
  final int selected;
  final bool busy;
  final ValueChanged<int> onSelect;
  final ValueChanged<BookSeriesMode> onChoose;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final book = books[selected];
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.sm,
        AppSpacing.xxs,
        AppSpacing.sm,
        AppSpacing.xs,
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.sm,
        AppSpacing.xs,
        AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(
                Icons.auto_stories_outlined,
                size: 20,
                color: colors.primary,
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Text(
                  seriesOfferHeadline(books, selected),
                  style: theme.textTheme.titleSmall,
                ),
              ),
              if (onClose != null)
                IconButton(
                  tooltip: 'Keep the current choice',
                  visualDensity: VisualDensity.compact,
                  onPressed: busy ? null : onClose,
                  icon: const Icon(Icons.close, size: 20),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(
              top: AppSpacing.xxs,
              right: AppSpacing.xs,
            ),
            child: Text(
              'Should this book follow on from it?',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
          if (books.length > 1)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Wrap(
                spacing: AppSpacing.xs,
                runSpacing: AppSpacing.xxs,
                children: [
                  for (var index = 0; index < books.length; index++)
                    ChoiceChip(
                      key: ValueKey('series-book-${books[index].projectId}'),
                      label: Text(
                        books[index].title,
                        overflow: TextOverflow.ellipsis,
                      ),
                      selected: index == selected,
                      onSelected: busy ? null : (_) => onSelect(index),
                    ),
                ],
              ),
            ),
          const SizedBox(height: AppSpacing.xs),
          _SeriesOption(
            key: const ValueKey('series-continue'),
            icon: Icons.arrow_forward,
            title: 'Continue “${book.title}”',
            subtitle:
                'Picks up where it ended, with the same characters, world and look.',
            enabled: !busy,
            onTap: () => onChoose(BookSeriesMode.continuation),
          ),
          _SeriesOption(
            key: const ValueKey('series-inspired'),
            icon: Icons.public,
            title: 'A new story in its world',
            subtitle: 'The same characters, world and look, with new events.',
            enabled: !busy,
            onTap: () => onChoose(BookSeriesMode.inspired),
          ),
          _SeriesOption(
            key: const ValueKey('series-standalone'),
            icon: Icons.auto_awesome_outlined,
            title: 'A separate story',
            subtitle: 'Only the characters come along.',
            enabled: !busy,
            onTap: () => onChoose(BookSeriesMode.standalone),
          ),
          if (busy)
            const Padding(
              padding: EdgeInsets.only(
                top: AppSpacing.xxs,
                right: AppSpacing.xs,
              ),
              child: LinearProgressIndicator(minHeight: 2),
            ),
        ],
      ),
    );
  }
}

/// The headline names who brought the earlier book up, and the book; a book
/// nobody's mention brought up (the one already chosen) is named alone.
String seriesOfferHeadline(List<MobileCreationSeriesBook> books, int selected) {
  final names = <String>{
    for (final book in books)
      for (final name in book.characterNames)
        if (name.trim().isNotEmpty) name.trim(),
  }.toList();
  if (names.isEmpty) {
    return 'This book and “${books[selected].title}”';
  }
  final who = names.length == 1
      ? names.first
      : names.length == 2
      ? '${names[0]} and ${names[1]}'
      : '${names.take(names.length - 1).join(', ')} and ${names.last}';
  final verb = names.length == 1 ? 'is' : 'are';
  return books.length == 1
      ? '$who $verb already in “${books.first.title}”'
      : '$who $verb already in ${books.length} of your books';
}

class _SeriesOption extends StatelessWidget {
  const _SeriesOption({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.enabled,
    required this.onTap,
    super.key,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadii.compact),
      onTap: enabled ? onTap : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minHeight: AppSizes.minimumTouchTarget,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: AppSpacing.xxs,
            horizontal: AppSpacing.xxs,
          ),
          child: Row(
            children: [
              Icon(icon, size: 20, color: colors.onSurfaceVariant),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title, style: theme.textTheme.bodyMedium),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The answer, said once, with the way to change it.
class _SeriesChoiceRow extends StatelessWidget {
  const _SeriesChoiceRow({
    required this.choice,
    required this.busy,
    required this.onChange,
    super.key,
  });

  final MobileCreationSeriesChoice choice;
  final bool busy;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Material(
      color: colors.surface,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.xs, 0),
        child: Row(
          children: [
            Icon(Icons.auto_stories_outlined, size: 18, color: colors.primary),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                seriesChoiceLabel(choice),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall,
              ),
            ),
            TextButton(
              key: const ValueKey('series-change'),
              onPressed: busy ? null : onChange,
              child: const Text('Change'),
            ),
          ],
        ),
      ),
    );
  }
}

/// What the reminder row says the book is.
String seriesChoiceLabel(MobileCreationSeriesChoice choice) {
  final title = choice.title ?? '';
  return switch (choice.mode) {
    BookSeriesMode.continuation => 'Continues “$title”',
    BookSeriesMode.inspired => 'A new story in the world of “$title”',
    BookSeriesMode.standalone => 'A separate story',
  };
}
