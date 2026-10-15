part of 'audiobook_screen.dart';

/// The deck at the bottom: where narration stands, the scrubber, the three
/// transport buttons, and the tools that change how the book plays.
class _PlayerControls extends ConsumerWidget {
  const _PlayerControls({required this.projectId, required this.state});

  final String projectId;
  final AudiobookState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final controller = ref.read(
      audiobookControllerProvider(projectId).notifier,
    );
    final audiobook = state.audiobook!;
    final total = state.totalDurationMs;
    final playable = state.playableUntilMs;
    final remaining = math.max(0, total - state.globalPositionMs);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(AppRadii.sheet),
        ),
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 20, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (state.offline) ...[
              _OfflineBanner(state: state),
              const SizedBox(height: 4),
            ] else if (audiobook.isGenerating || playable < total) ...[
              _NarrationBanner(audiobook: audiobook, caughtUp: state.caughtUp),
              const SizedBox(height: 4),
            ],
            _BookScrubber(
              positionMs: state.globalPositionMs,
              totalMs: total,
              playableMs: playable,
              chapters: state.timeline?.chapters ?? const [],
              onSeek: controller.seekGlobal,
            ),
            _TimeRow(
              elapsedMs: state.globalPositionMs,
              remainingMs: remaining,
              buffering: state.buffering,
            ),
            const SizedBox(height: 6),
            // Transport reads left to right in every language, like the tape
            // it is named after: back on the left, forward on the right.
            Directionality(
              textDirection: TextDirection.ltr,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _SkipButton(
                    forward: false,
                    onPressed: () {
                      AppHaptics.tap();
                      controller.skip(-AudiobookController.skipInterval);
                    },
                  ),
                  const SizedBox(width: 18),
                  _PlayButton(
                    playing: state.playing,
                    buffering: state.buffering,
                    onPressed: () {
                      AppHaptics.commit();
                      controller.togglePlay();
                    },
                  ),
                  const SizedBox(width: 18),
                  _SkipButton(
                    forward: true,
                    onPressed: () {
                      AppHaptics.tap();
                      controller.skip(AudiobookController.skipInterval);
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: _ToolButton(
                    leading: Text(
                      _speedLabel(state.speed),
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                    label: 'Speed',
                    semanticLabel:
                        'Playback speed, ${_speedLabel(state.speed)}',
                    onPressed: () => showAudiobookSpeedSheet(
                      context,
                      speed: state.speed,
                      onSelected: (speed) {
                        AppHaptics.selection();
                        controller.setSpeed(speed);
                      },
                    ),
                  ),
                ),
                Expanded(
                  child: _SleepToolButton(
                    until: state.sleepTimerEnd,
                    onPressed: () => showAudiobookSleepSheet(
                      context,
                      until: state.sleepTimerEnd,
                      onSelected: controller.setSleepTimer,
                    ),
                  ),
                ),
                Expanded(
                  child: _ToolButton(
                    leading: const Icon(Icons.format_list_bulleted_rounded),
                    label: 'Chapters',
                    onPressed: () => showAudiobookChaptersSheet(
                      context,
                      projectId: projectId,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "3 of 8 chapters" and a bar that moves while the rest of the book is still
/// being read aloud — or the reason it stopped, when it has.
///
/// The words are the listener's answer to "why did it stop?": reaching the end
/// of what exists is not the same as reaching the end of the book, and nothing
/// else on screen says so.
class _NarrationBanner extends StatelessWidget {
  const _NarrationBanner({required this.audiobook, required this.caughtUp});

  final MobileAudiobook audiobook;
  final bool caughtUp;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final generating = audiobook.isGenerating;
    final progress = audiobook.progress;
    final count = progress != null && progress.chapterCount > 0
        ? progress.chapterCount
        : audiobook.chapters.length;
    final ready = progress != null && progress.chapterCount > 0
        ? progress.chaptersReady
        : audiobook.chapters.where((chapter) => chapter.isReady).length;

    final label = caughtUp
        ? 'Waiting for the next chapter'
        : generating
        ? 'Still narrating'
        : 'Part of the book could not be narrated';
    final tone = generating
        ? colors.primary
        : AppSemanticColors.of(context).warning;

    return Semantics(
      container: true,
      liveRegion: true,
      label: '$label, $ready of $count chapters ready',
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    if (generating)
                      PlanBuildSparkle(color: tone, size: 18)
                    else
                      Icon(Icons.info_outline, size: 18, color: tone),
                    const SizedBox(width: 8),
                    Expanded(
                      child: RisingStatusText(
                        text: label,
                        maxLines: 1,
                        style: theme.textTheme.labelLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: colors.onSurface,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      count > 0 ? '$ready of $count' : '',
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
                if (generating && count > 0) ...[
                  const SizedBox(height: 8),
                  PlanBuildProgressBar(
                    value: ready / count,
                    height: 4,
                    trackColor: colors.surfaceContainerHighest,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Offline: what is playing is what this phone holds. Still, with no sparkle
/// and no moving bar — a narration that was being made when the manifest was
/// kept is a memory here, not work in progress.
class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.state});

  final AudiobookState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final count = state.audiobook?.chapters.length ?? 0;
    final here = state.downloadedChapters.length;
    final label = here < count
        ? 'Offline — $here of $count chapters on this phone'
        : 'Offline — playing the copy on this phone';
    return Semantics(
      container: true,
      label: label,
      child: ExcludeSemantics(
        child: DecoratedBox(
          key: const ValueKey('audiobook-offline-banner'),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
            child: Row(
              children: [
                Icon(
                  Icons.cloud_off_outlined,
                  size: 18,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 2,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: colors.onSurface,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Elapsed on one side, what is left on the other, and — between them — the
/// one thing that is worth saying about the moment: it is buffering.
class _TimeRow extends StatelessWidget {
  const _TimeRow({
    required this.elapsedMs,
    required this.remainingMs,
    required this.buffering,
  });

  final int elapsedMs;
  final int remainingMs;
  final bool buffering;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = theme.textTheme.labelMedium?.copyWith(
      color: colors.onSurfaceVariant,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        children: [
          Directionality(
            textDirection: TextDirection.ltr,
            child: Text(formatAudiobookDuration(elapsedMs), style: style),
          ),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: AnimatedOpacity(
                duration: AppMotion.fast,
                opacity: buffering ? 1 : 0,
                child: Text(
                  buffering ? 'Buffering…' : '',
                  textAlign: TextAlign.center,
                  style: style,
                ),
              ),
            ),
          ),
          Directionality(
            textDirection: TextDirection.ltr,
            child: Text(
              '−${formatAudiobookDuration(remainingMs)}',
              style: style,
            ),
          ),
        ],
      ),
    );
  }
}

/// The one button that matters. It says which of three things is true — paused,
/// playing, or waiting on audio — without ever hiding whether pressing it will
/// play or pause: while buffering the glyph stays and a ring circles it.
class _PlayButton extends StatelessWidget {
  const _PlayButton({
    required this.playing,
    required this.buffering,
    required this.onPressed,
  });

  final bool playing;
  final bool buffering;
  final VoidCallback onPressed;

  static const double _diameter = 72;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: playing ? 'Pause' : 'Play',
      value: buffering ? 'Buffering' : null,
      onTap: onPressed,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: _diameter + 12,
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (buffering)
                SizedBox.square(
                  dimension: _diameter + 10,
                  child: CircularProgressIndicator(
                    strokeWidth: 3,
                    color: colors.primary,
                    backgroundColor: colors.primary.withValues(alpha: 0.16),
                  ),
                ),
              Material(
                color: colors.primary,
                shape: const CircleBorder(),
                elevation: 2,
                shadowColor: Colors.black54,
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: onPressed,
                  child: SizedBox.square(
                    dimension: _diameter,
                    child: AnimatedSwitcher(
                      duration: AppMotion.fast,
                      transitionBuilder: (child, animation) =>
                          ScaleTransition(scale: animation, child: child),
                      child: Icon(
                        playing
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded,
                        key: ValueKey(playing),
                        size: 40,
                        color: colors.onPrimary,
                      ),
                    ),
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

class _SkipButton extends StatelessWidget {
  const _SkipButton({required this.forward, required this.onPressed});

  final bool forward;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final seconds = AudiobookController.skipInterval.inSeconds;
    return Semantics(
      button: true,
      label: forward
          ? 'Skip forward $seconds seconds'
          : 'Skip back $seconds seconds',
      onTap: onPressed,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: 60,
          child: IconButton(
            onPressed: onPressed,
            padding: EdgeInsets.zero,
            icon: Stack(
              alignment: Alignment.center,
              children: [
                Transform.scale(
                  scaleX: forward ? -1 : 1,
                  child: const Icon(Icons.replay, size: 36),
                ),
                // Ignored for hit-testing so the tap lands on the button, not
                // on the label sitting in the middle of it.
                IgnorePointer(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      '$seconds',
                      style: theme.textTheme.labelSmall?.copyWith(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// An icon (or any glyph) over a word: the row of things that change how the
/// book plays. Words rather than bare icons, because "what does the moon do?"
/// is a question nobody should have to answer by pressing it.
class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.leading,
    required this.label,
    required this.onPressed,
    this.semanticLabel,
    this.active = false,
  });

  final Widget leading;
  final String label;
  final String? semanticLabel;
  final bool active;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final color = active ? colors.primary : colors.onSurfaceVariant;
    return Semantics(
      button: true,
      label: semanticLabel ?? label,
      onTap: onPressed,
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.control),
          onTap: () {
            AppHaptics.tap();
            onPressed();
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget + 8,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconTheme.merge(
                    data: IconThemeData(color: color, size: 26),
                    child: DefaultTextStyle.merge(
                      style: TextStyle(color: color),
                      child: SizedBox(
                        height: 28,
                        child: Center(child: leading),
                      ),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: color,
                      fontWeight: active ? FontWeight.w800 : FontWeight.w600,
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

/// The sleep timer's tool: a moon that says how long is left once it is set.
class _SleepToolButton extends StatefulWidget {
  const _SleepToolButton({required this.until, required this.onPressed});

  final DateTime? until;
  final VoidCallback onPressed;

  @override
  State<_SleepToolButton> createState() => _SleepToolButtonState();
}

class _SleepToolButtonState extends State<_SleepToolButton> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant _SleepToolButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  /// Ticks only while a timer is running: the label is minutes, so twice a
  /// minute is plenty, and an idle button has nothing to redraw.
  void _sync() {
    if (widget.until == null) {
      _tick?.cancel();
      _tick = null;
    } else {
      _tick ??= Timer.periodic(const Duration(seconds: 20), (_) {
        if (mounted) {
          setState(() {});
        }
      });
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final until = widget.until;
    final left = until == null ? null : _minutesLeft(until);
    return _ToolButton(
      leading: Icon(until == null ? Icons.bedtime_outlined : Icons.bedtime),
      label: left == null ? 'Sleep' : '$left min',
      semanticLabel: left == null
          ? 'Sleep timer, off'
          : 'Sleep timer, $left ${left == 1 ? 'minute' : 'minutes'} left',
      active: until != null,
      onPressed: widget.onPressed,
    );
  }
}

/// Whole minutes left, rounded up: "1 min" until the very end, never "0 min".
int _minutesLeft(DateTime until) {
  final seconds = until.difference(DateTime.now()).inSeconds;
  return math.max(1, (seconds / 60).ceil());
}

String _speedLabel(double speed) {
  final text = speed == speed.roundToDouble()
      ? speed.toStringAsFixed(0)
      : speed.toString();
  return '${text}x';
}
