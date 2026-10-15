part of 'audiobook_screen.dart';

// Every state of the screen that is not the player: waiting to find out,
// nothing narrated yet, narration being made, narration that stopped, and the
// notice that a narration no longer matches its book.

/// A grey outline of the player, so the wait to hear whether a narration exists
/// has the shape of what is about to appear rather than a lone spinner.
class _PlayerSkeleton extends StatelessWidget {
  const _PlayerSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget block(double width, double height, {double radius = 8}) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(radius),
      ),
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Looking for your audiobook',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 14),
                child: Row(
                  children: [
                    block(48, 72, radius: AppRadii.compact),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          block(180, 16),
                          const SizedBox(height: 8),
                          block(120, 12),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final width in const [
                        0.5,
                        1.0,
                        0.92,
                        0.7,
                        1.0,
                        0.85,
                        0.4,
                      ])
                        Padding(
                          padding: const EdgeInsets.only(bottom: 14),
                          child: FractionallySizedBox(
                            widthFactor: width,
                            child: block(double.infinity, 14),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.surfaceContainerLow,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(AppRadii.sheet),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 22, 24, 22),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      block(double.infinity, 5, radius: 3),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [block(34, 10), block(44, 10)],
                      ),
                      const SizedBox(height: 18),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          block(48, 48, radius: 24),
                          const SizedBox(width: 22),
                          block(72, 72, radius: 36),
                          const SizedBox(width: 22),
                          block(48, 48, radius: 24),
                        ],
                      ),
                      const SizedBox(height: 18),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                        children: [block(44, 34), block(44, 34), block(60, 34)],
                      ),
                    ],
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

/// A book with no narration: what it is, what it is like, and the one button.
class _NotNarratedYet extends StatelessWidget {
  const _NotNarratedYet({
    required this.onStart,
    required this.busy,
    this.planLocked = false,
  });

  final VoidCallback onStart;
  final bool busy;

  /// Narration is a plan perk this reader does not have yet: the page still
  /// says what it would be, and the button opens the plans ([onStart] does).
  final bool planLocked;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    const perks = [
      (
        Icons.subtitles_outlined,
        'The words follow along, sentence by sentence',
      ),
      (Icons.headphones_outlined, 'Keeps playing with your screen off'),
      (Icons.format_list_bulleted_rounded, 'Jump to any chapter, at any speed'),
    ];
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: colors.primaryContainer,
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: Icon(
                    Icons.headphones,
                    size: 36,
                    color: colors.primary,
                  ),
                ),
              ),
              const SizedBox(height: 18),
              Semantics(
                header: true,
                child: Text(
                  'Hear your book read aloud',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Pick a narrator and we will read the whole book to you. The first chapter is usually ready within a couple of minutes.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 20),
              for (final (icon, text) in perks)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(
                    children: [
                      Icon(icon, size: 20, color: colors.primary),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(text, style: theme.textTheme.bodyMedium),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 24),
              if (planLocked) ...[
                Text(
                  audiobooksPlanMessage,
                  key: const ValueKey('audiobook-plan-locked'),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),
              ],
              AppButton.primary(
                label: planLocked ? 'See plans' : 'Choose a narrator',
                loadingLabel: 'Starting…',
                loading: busy,
                onPressed: onStart,
                leading: Icon(
                  planLocked
                      ? Icons.lock_outline
                      : Icons.record_voice_over_outlined,
                ),
                expanded: true,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A narration the server gave up on. The refund is already in the message —
/// the worker writes it — so this only has to make the way forward obvious.
class _NarrationStopped extends StatelessWidget {
  const _NarrationStopped({
    required this.message,
    required this.onChooseNarrator,
  });

  final String message;
  final VoidCallback onChooseNarrator;

  @override
  Widget build(BuildContext context) {
    return AppErrorState(
      title: 'Narration stopped',
      message: message,
      icon: Icons.mic_off_outlined,
      actionLabel: 'Choose a narrator',
      actionIcon: Icons.record_voice_over_outlined,
      onRetry: onChooseNarrator,
    );
  }
}

/// The gap between paying and the first chapter landing — and, for a long book,
/// most of the time before the first chapter has downloaded.
///
/// It is the moment someone is most likely to wonder whether anything happened,
/// so it shows work: a living mark, the step the narrator is on, a bar that
/// moves when a chapter lands, and a dot for every chapter in the book.
class _PreparingNarration extends StatelessWidget {
  const _PreparingNarration({required this.audiobook});

  final MobileAudiobook audiobook;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final progress = audiobook.progress;
    final count = progress != null && progress.chapterCount > 0
        ? progress.chapterCount
        : audiobook.chapters.length;
    final ready = progress != null && progress.chapterCount > 0
        ? progress.chaptersReady
        : audiobook.chapters.where((chapter) => chapter.isReady).length;
    final double? value = count > 0
        ? ready / count
        : progress != null && progress.percent > 0
        ? progress.percent / 100
        : null;
    final action = progress?.currentAction.trim() ?? '';

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Semantics(
            container: true,
            liveRegion: true,
            label:
                '${audiobook.narratorName} is preparing your narration. '
                '${action.isEmpty ? '' : '$action. '}'
                '${count > 0 ? '$ready of $count chapters ready.' : ''}',
            child: ExcludeSemantics(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const _NarrationOrb(),
                  const SizedBox(height: 26),
                  Text(
                    ready == 0
                        ? '${audiobook.narratorName} is warming up'
                        : 'Getting your first chapter ready',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  RisingStatusText(
                    text: action.isEmpty ? 'Preparing narration' : action,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                    maxLines: 2,
                  ),
                  if (audiobook.backupNarrationUsed) ...[
                    const SizedBox(height: 6),
                    Text(
                      'Generated with backup narration',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                  const SizedBox(height: 22),
                  PlanBuildProgressBar(
                    value: value,
                    height: 8,
                    semanticLabel: 'Narration progress',
                  ),
                  if (count > 0) ...[
                    const SizedBox(height: 10),
                    Text(
                      '$ready of $count ${count == 1 ? 'chapter' : 'chapters'} narrated',
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                  if (audiobook.chapters.length > 1 &&
                      audiobook.chapters.length <= 40) ...[
                    const SizedBox(height: 16),
                    _ChapterDots(chapters: audiobook.chapters),
                  ],
                  const SizedBox(height: 22),
                  Text(
                    'You can leave this screen — we will keep narrating.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
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

/// One dot per chapter: filled once narrated, breathing for the one being read
/// now, hollow for those still to come.
class _ChapterDots extends StatelessWidget {
  const _ChapterDots({required this.chapters});

  final List<MobileAudiobookChapter> chapters;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final working = chapters.indexWhere((chapter) => !chapter.isReady);
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final (position, chapter) in chapters.indexed)
          _dot(
            colors,
            filled: chapter.isReady,
            failed: chapter.status == AudiobookChapterStatus.failed,
            working:
                position == working &&
                chapter.status == AudiobookChapterStatus.pending,
          ),
      ],
    );
  }

  Widget _dot(
    ColorScheme colors, {
    required bool filled,
    required bool failed,
    required bool working,
  }) {
    final dot = Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: filled
            ? colors.primary
            : working
            ? colors.primary.withValues(alpha: 0.55)
            : Colors.transparent,
        border: filled
            ? null
            : Border.all(
                color: failed
                    ? colors.error
                    : working
                    ? colors.primary
                    : colors.outlineVariant,
                width: 1.5,
              ),
      ),
    );
    return working ? AppShimmer(child: dot) : dot;
  }
}

/// A sparkle at rest inside a circle that sends out slow rings, so the wait
/// looks like something being made rather than something stuck.
class _NarrationOrb extends StatefulWidget {
  const _NarrationOrb();

  @override
  State<_NarrationOrb> createState() => _NarrationOrbState();
}

class _NarrationOrbState extends State<_NarrationOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _rings = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2800),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AppMotion.reducedMotion(context)) {
      _rings.stop();
    } else if (!_rings.isAnimating) {
      _rings.repeat();
    }
  }

  @override
  void dispose() {
    _rings.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: 132,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AnimatedBuilder(
            animation: _rings,
            builder: (context, _) => CustomPaint(
              size: const Size.square(132),
              painter: _RingsPainter(
                t: AppMotion.reducedMotion(context) ? null : _rings.value,
                color: colors.primary,
              ),
            ),
          ),
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  colors.primary,
                  Color.lerp(colors.primary, colors.tertiary, 0.6)!,
                ],
              ),
            ),
            child: Center(
              child: PlanBuildSparkle(color: colors.onPrimary, size: 40),
            ),
          ),
        ],
      ),
    );
  }
}

class _RingsPainter extends CustomPainter {
  const _RingsPainter({required this.t, required this.color});

  /// Position in the cycle, or null when there is to be no motion.
  final double? t;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final inner = size.shortestSide * 0.32;
    final outer = size.shortestSide * 0.5;
    if (t == null) {
      canvas.drawCircle(
        centre,
        outer - 2,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = color.withValues(alpha: 0.18),
      );
      return;
    }
    // Two rings half a cycle apart: as one fades out at the edge the other is
    // just leaving the circle, so there is always something in motion.
    for (var i = 0; i < 2; i += 1) {
      final phase = (t! + i * 0.5) % 1;
      final eased = Curves.easeOut.transform(phase);
      canvas.drawCircle(
        centre,
        inner + (outer - inner) * eased,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = color.withValues(alpha: 0.34 * (1 - phase)),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RingsPainter oldDelegate) =>
      oldDelegate.t != t || oldDelegate.color != color;
}

/// "You edited the book after this was narrated." One line and one button: the
/// audio still plays, it just no longer says what the pages say.
class _StaleBanner extends StatelessWidget {
  const _StaleBanner({required this.onRenarrate});

  final VoidCallback onRenarrate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tone = appToneColors(context, AppTone.warning);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
      child: Semantics(
        container: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tone.background,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(color: tone.foreground.withValues(alpha: 0.18)),
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(12, 8, 8, 8),
            child: Row(
              children: [
                ExcludeSemantics(
                  child: Icon(Icons.edit_note_rounded, color: tone.foreground),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'You have edited this book since it was narrated.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: tone.foreground,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                OutlinedButton(
                  onPressed: () {
                    AppHaptics.tap();
                    onRenarrate();
                  },
                  style: OutlinedButton.styleFrom(
                    foregroundColor: tone.foreground,
                    side: BorderSide(
                      color: tone.foreground.withValues(alpha: 0.5),
                    ),
                    minimumSize: const Size(64, 40),
                    tapTargetSize: MaterialTapTargetSize.padded,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  child: const Text('Re-narrate'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Offline, and nothing of this narration is on the phone to play. Not an
/// error and not a narration in progress: the way out is a connection, and
/// "Try again" asks the server the moment there is one.
class _NotOnThisPhone extends StatelessWidget {
  const _NotOnThisPhone({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: AppEmptyState(
          key: const ValueKey('audiobook-not-on-phone'),
          icon: Icons.cloud_off_outlined,
          title: 'Not on this phone yet',
          message:
              "This narration hasn't been downloaded to this phone. Connect "
              'to the internet to listen — chapters stay on the phone after '
              'that.',
          actionLabel: 'Try again',
          onAction: onRetry,
        ),
      ),
    );
  }
}
