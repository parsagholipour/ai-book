part of 'audiobook_screen.dart';

// The three small sheets behind the tool row: how fast, when to stop, and where
// to go. Each is a bottom sheet rather than a popup menu — a thumb can reach it,
// its options are big enough to hit, and it has room to say what it does.

/// "1h 23m", "42 min", "50 sec": a length a person would say out loud.
String _humanDuration(int milliseconds) {
  final totalSeconds = (milliseconds / 1000).round();
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  if (hours > 0) {
    return minutes == 0 ? '${hours}h' : '${hours}h ${minutes}m';
  }
  if (minutes > 0) {
    return '$minutes min';
  }
  return '${math.max(1, totalSeconds)} sec';
}

class _SheetHeading extends StatelessWidget {
  const _SheetHeading({required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(22, 4, 22, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              title,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(
              subtitle!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ------------------------------------------------------------------- speed

Future<void> showAudiobookSpeedSheet(
  BuildContext context, {
  required double speed,
  required ValueChanged<double> onSelected,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (sheetContext) => _SpeedSheet(
      speed: speed,
      onSelected: (next) {
        onSelected(next);
        Navigator.of(sheetContext).pop();
      },
    ),
  );
}

class _SpeedSheet extends StatelessWidget {
  const _SpeedSheet({required this.speed, required this.onSelected});

  final double speed;
  final ValueChanged<double> onSelected;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SheetHeading(
            title: 'Playback speed',
            subtitle: 'Applies to the whole book.',
          ),
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(22, 0, 22, 24),
            child: LayoutBuilder(
              builder: (context, constraints) {
                const gap = 10.0;
                final width = (constraints.maxWidth - gap * 2) / 3;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: [
                    for (final option in AudiobookController.speedOptions)
                      SizedBox(
                        width: width,
                        child: _SpeedOption(
                          label: _speedLabel(option),
                          selected: option == speed,
                          onTap: () => onSelected(option),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _SpeedOption extends StatelessWidget {
  const _SpeedOption({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: selected
              ? colors.primaryContainer
              : colors.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppRadii.control),
            onTap: onTap,
            child: Container(
              height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(AppRadii.control),
                border: Border.all(
                  color: selected ? colors.primary : Colors.transparent,
                  width: 1.5,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (selected) ...[
                    Icon(Icons.check, size: 18, color: colors.primary),
                    const SizedBox(width: 6),
                  ],
                  Text(
                    label,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: selected
                          ? colors.onPrimaryContainer
                          : colors.onSurface,
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

// ------------------------------------------------------------------- sleep

Future<void> showAudiobookSleepSheet(
  BuildContext context, {
  required DateTime? until,
  required void Function(Duration?) onSelected,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (sheetContext) => _SleepSheet(
      until: until,
      onSelected: (duration) {
        onSelected(duration);
        Navigator.of(sheetContext).pop();
      },
    ),
  );
}

class _SleepSheet extends StatelessWidget {
  const _SleepSheet({required this.until, required this.onSelected});

  final DateTime? until;
  final void Function(Duration?) onSelected;

  static const _options = [
    (label: '15 minutes', minutes: 15),
    (label: '30 minutes', minutes: 30),
    (label: '45 minutes', minutes: 45),
    (label: '1 hour', minutes: 60),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final left = until == null ? null : _minutesLeft(until!);
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SheetHeading(
            title: 'Sleep timer',
            subtitle: left == null
                ? 'Pause the narration after a while, so you can fall asleep to it.'
                : 'Pauses in about $left ${left == 1 ? 'minute' : 'minutes'}.',
          ),
          for (final option in _options)
            ListTile(
              minTileHeight: 56,
              contentPadding: const EdgeInsets.symmetric(horizontal: 22),
              leading: Icon(
                Icons.bedtime_outlined,
                color: colors.onSurfaceVariant,
              ),
              title: Text(option.label),
              onTap: () => onSelected(Duration(minutes: option.minutes)),
            ),
          if (left != null)
            ListTile(
              minTileHeight: 56,
              contentPadding: const EdgeInsets.symmetric(horizontal: 22),
              leading: Icon(Icons.timer_off_outlined, color: colors.error),
              title: Text(
                'Turn off the timer',
                style: TextStyle(color: colors.error),
              ),
              onTap: () => onSelected(null),
            ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- chapters

Future<void> showAudiobookChaptersSheet(
  BuildContext context, {
  required String projectId,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (sheetContext) => _ChaptersSheet(projectId: projectId),
  );
}

/// Every chapter, with the one playing now marked and its length beside it.
///
/// Watches the controller rather than taking a snapshot, so a narration that
/// is still being made keeps ticking chapters over from "narrating" to
/// playable while the sheet is open.
class _ChaptersSheet extends ConsumerStatefulWidget {
  const _ChaptersSheet({required this.projectId});

  final String projectId;

  @override
  ConsumerState<_ChaptersSheet> createState() => _ChaptersSheetState();
}

class _ChaptersSheetState extends ConsumerState<_ChaptersSheet> {
  final GlobalKey _currentKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    // Opens on the chapter being heard: in a long book it is otherwise a
    // scroll away, and "where am I" is the reason the sheet was opened.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _currentKey.currentContext;
      if (mounted && target != null && target.mounted) {
        Scrollable.ensureVisible(target, alignment: 0.3);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = ref.watch(audiobookControllerProvider(widget.projectId));
    final timeline = state.timeline;
    final chapters = timeline?.chapters ?? const <MobileAudiobookChapter>[];
    final controller = ref.read(
      audiobookControllerProvider(widget.projectId).notifier,
    );
    final currentAt = chapters.indexWhere(
      (chapter) => chapter.index == state.chapterIndex,
    );

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: (0.3 + chapters.length * 0.09).clamp(0.45, 0.9),
      minChildSize: 0.4,
      maxChildSize: 0.92,
      builder: (context, scrollController) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _SheetHeading(
              title: 'Chapters',
              subtitle: chapters.isEmpty
                  ? null
                  : '${chapters.length} '
                        '${chapters.length == 1 ? 'chapter' : 'chapters'}'
                        ' · ${_humanDuration(state.totalDurationMs)}',
            ),
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  for (final (position, chapter) in chapters.indexed)
                    _ChapterTile(
                      key: position == currentAt ? _currentKey : null,
                      number: position + 1,
                      chapter: chapter,
                      current: position == currentAt,
                      playing: state.playing,
                      playable: state.downloadedChapters.contains(
                        chapter.index,
                      ),
                      onTap: () async {
                        AppHaptics.selection();
                        final navigator = Navigator.of(context);
                        await controller.seekGlobal(
                          timeline!.startOfChapter(chapter.index),
                        );
                        // Choosing a chapter means "read me this", not "park me
                        // at the start of it".
                        if (!ref
                            .read(audiobookControllerProvider(widget.projectId))
                            .playing) {
                          await controller.togglePlay();
                        }
                        if (navigator.mounted) {
                          navigator.pop();
                        }
                      },
                    ),
                  if (chapters.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'The chapters appear here as they are narrated.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _ChapterTile extends StatelessWidget {
  const _ChapterTile({
    required this.number,
    required this.chapter,
    required this.current,
    required this.playing,
    required this.playable,
    required this.onTap,
    super.key,
  });

  final int number;
  final MobileAudiobookChapter chapter;
  final bool current;
  final bool playing;

  /// Downloaded, so a tap can actually go there.
  final bool playable;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final measured = chapter.durationMs != null;
    final status = switch (chapter.status) {
      AudiobookChapterStatus.failed => 'Could not be narrated',
      AudiobookChapterStatus.pending => 'Narrating…',
      AudiobookChapterStatus.ready when !playable => 'Getting ready…',
      _ => null,
    };
    final duration = chapter.effectiveDurationMs > 0
        ? '${measured ? '' : '~'}${_humanDuration(chapter.effectiveDurationMs)}'
        : '';
    final enabled = playable && chapter.isReady;
    final title = _chapterTitle(chapter);

    return Semantics(
      button: enabled,
      selected: current,
      enabled: enabled,
      onTap: enabled ? onTap : null,
      label: [
        'Chapter $number, $title',
        if (current) 'playing now',
        ?status,
        if (duration.isNotEmpty) duration,
      ].join(', '),
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          child: Material(
            color: current
                ? colors.primaryContainer.withValues(alpha: 0.7)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(AppRadii.control),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadii.control),
              onTap: enabled ? onTap : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 60),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 32,
                        child: Center(
                          child: current
                              ? AudioSoundBars(
                                  active: playing,
                                  color: colors.primary,
                                  size: 20,
                                )
                              : Text(
                                  '$number',
                                  style: theme.textTheme.labelLarge?.copyWith(
                                    color: colors.onSurfaceVariant,
                                    fontFeatures: const [
                                      FontFeature.tabularFigures(),
                                    ],
                                  ),
                                ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.titleSmall?.copyWith(
                                fontWeight: current
                                    ? FontWeight.w800
                                    : FontWeight.w600,
                                color: enabled || current
                                    ? colors.onSurface
                                    : colors.onSurfaceVariant,
                              ),
                            ),
                            if (status != null)
                              Text(
                                status,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color:
                                      chapter.status ==
                                          AudiobookChapterStatus.failed
                                      ? colors.error
                                      : colors.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (duration.isNotEmpty) ...[
                        const SizedBox(width: 10),
                        Text(
                          duration,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: colors.onSurfaceVariant,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
