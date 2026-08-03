part of 'audiobook_screen.dart';

/// Cover, title and narrator. Shrinks to a strip when the transcript is open,
/// because then the words matter more than the artwork.
class _NowPlayingHeader extends StatelessWidget {
  const _NowPlayingHeader({
    required this.bookTitle,
    required this.audiobook,
    required this.coverUrl,
    required this.compact,
  });

  final String bookTitle;
  final MobileAudiobook audiobook;
  final String? coverUrl;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final size = compact ? 56.0 : 180.0;

    final artwork = AnimatedContainer(
      duration: AppMotion.medium,
      curve: AppMotion.standard,
      width: size,
      height: size * 1.3,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(compact ? 10 : TomezaRadii.card),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colors.primary,
            Color.lerp(colors.primary, colors.tertiary, 0.55)!,
          ],
        ),
        boxShadow: compact
            ? null
            : [
                BoxShadow(
                  color: colors.primary.withValues(alpha: 0.24),
                  blurRadius: 28,
                  offset: const Offset(0, 12),
                ),
              ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Icon(
        Icons.auto_stories_outlined,
        color: colors.onPrimary.withValues(alpha: 0.85),
        size: compact ? 24 : 56,
      ),
    );

    final labels = Column(
      crossAxisAlignment: compact
          ? CrossAxisAlignment.start
          : CrossAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          bookTitle,
          maxLines: compact ? 1 : 2,
          overflow: TextOverflow.ellipsis,
          textAlign: compact ? TextAlign.start : TextAlign.center,
          style:
              (compact
                      ? theme.textTheme.titleSmall
                      : theme.textTheme.titleLarge)
                  ?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.graphic_eq, size: 14, color: colors.onSurfaceVariant),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                'Narrated by ${audiobook.narratorName}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
        if (audiobook.backupNarrationUsed) ...[
          const SizedBox(height: 3),
          Text(
            'Generated with backup narration',
            textAlign: compact ? TextAlign.start : TextAlign.center,
            style: theme.textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );

    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        compact ? 12 : 24,
        20,
        compact ? 12 : 20,
      ),
      child: compact
          ? Row(
              children: [
                artwork,
                const SizedBox(width: 14),
                Expanded(child: labels),
              ],
            )
          : Column(children: [artwork, const SizedBox(height: 20), labels]),
    );
  }
}

class _PlayerControls extends ConsumerWidget {
  const _PlayerControls({required this.projectId, required this.state});

  final String projectId;
  final AudiobookState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final controller = ref.read(
      audiobookControllerProvider(projectId).notifier,
    );
    final total = state.totalDurationMs;
    final playable = state.playableUntilMs;

    return Container(
      padding: EdgeInsets.fromLTRB(
        20,
        12,
        20,
        16 + MediaQuery.viewPaddingOf(context).bottom,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _BookScrubber(
            positionMs: state.globalPositionMs,
            totalMs: total,
            playableMs: playable,
            onSeek: controller.seekGlobal,
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  formatAudiobookDuration(state.globalPositionMs),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                // Why playback stopped, when it stopped on its own: the
                // listener reached the end of what exists rather than the end
                // of the book, and nothing else on screen says so.
                if (playable < total)
                  Flexible(
                    child: Text(
                      state.caughtUp
                          ? 'waiting for the next chapter'
                          : 'still narrating',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: colors.primary,
                      ),
                    ),
                  ),
                Text(
                  formatAudiobookDuration(total),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _SpeedButton(
                speed: state.speed,
                onSelected: (speed) {
                  AppHaptics.selection();
                  controller.setSpeed(speed);
                },
              ),
              _SkipButton(
                icon: Icons.replay,
                label: '15',
                onPressed: () {
                  AppHaptics.tap();
                  controller.skip(-AudiobookController.skipInterval);
                },
              ),
              _PlayButton(
                playing: state.playing,
                busy: state.buffering,
                onPressed: () {
                  AppHaptics.commit();
                  controller.togglePlay();
                },
              ),
              _SkipButton(
                icon: Icons.replay,
                mirrored: true,
                label: '15',
                onPressed: () {
                  AppHaptics.tap();
                  controller.skip(AudiobookController.skipInterval);
                },
              ),
              _SleepTimerButton(
                until: state.sleepTimerEnd,
                onSelected: controller.setSleepTimer,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One scrubber for the whole book. The narrated part is solid; the part still
/// being made is a fainter track behind it, so the book's full length is
/// visible from the first minute without pretending it can all be played.
class _BookScrubber extends StatefulWidget {
  const _BookScrubber({
    required this.positionMs,
    required this.totalMs,
    required this.playableMs,
    required this.onSeek,
  });

  final int positionMs;
  final int totalMs;
  final int playableMs;
  final void Function(int positionMs) onSeek;

  @override
  State<_BookScrubber> createState() => _BookScrubberState();
}

class _BookScrubberState extends State<_BookScrubber> {
  double? _dragValue;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final total = widget.totalMs <= 0 ? 1 : widget.totalMs;
    final value = (_dragValue ?? widget.positionMs.toDouble()).clamp(
      0,
      total.toDouble(),
    );

    return Stack(
      alignment: Alignment.center,
      children: [
        // The "already narrated" extent, drawn behind the slider's own track.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: (widget.playableMs / total).clamp(0.0, 1.0),
              minHeight: 4,
              backgroundColor: colors.outlineVariant.withValues(alpha: 0.5),
              valueColor: AlwaysStoppedAnimation(
                colors.primary.withValues(alpha: 0.28),
              ),
            ),
          ),
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 4,
            inactiveTrackColor: Colors.transparent,
            overlayShape: const RoundSliderOverlayShape(overlayRadius: 16),
          ),
          child: Slider(
            value: value.toDouble(),
            max: total.toDouble(),
            onChanged: (next) => setState(() => _dragValue = next),
            onChangeEnd: (next) {
              setState(() => _dragValue = null);
              AppHaptics.selection();
              widget.onSeek(next.round());
            },
          ),
        ),
      ],
    );
  }
}

class _PlayButton extends StatelessWidget {
  const _PlayButton({
    required this.playing,
    required this.busy,
    required this.onPressed,
  });

  final bool playing;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: playing ? 'Pause' : 'Play',
      child: ExcludeSemantics(
        child: Material(
          color: colors.primary,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox(
              width: 68,
              height: 68,
              child: busy
                  ? Padding(
                      padding: const EdgeInsets.all(22),
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: colors.onPrimary,
                      ),
                    )
                  : Icon(
                      playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                      size: 36,
                      color: colors.onPrimary,
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SkipButton extends StatelessWidget {
  const _SkipButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.mirrored = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  /// Flips the replay glyph so back and forward read as a matched pair.
  final bool mirrored;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      button: true,
      label: 'Skip $label seconds',
      child: ExcludeSemantics(
        child: IconButton(
          onPressed: onPressed,
          iconSize: 30,
          icon: Stack(
            alignment: Alignment.center,
            children: [
              Transform.scale(
                scaleX: mirrored ? -1 : 1,
                child: Icon(icon, size: 30),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
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

class _SpeedButton extends StatelessWidget {
  const _SpeedButton({required this.speed, required this.onSelected});

  final double speed;
  final ValueChanged<double> onSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return PopupMenuButton<double>(
      tooltip: 'Playback speed',
      onSelected: onSelected,
      itemBuilder: (context) => [
        for (final option in AudiobookController.speedOptions)
          PopupMenuItem(
            value: option,
            child: Row(
              children: [
                if (option == speed)
                  const Icon(Icons.check, size: 18)
                else
                  const SizedBox(width: 18),
                const SizedBox(width: 10),
                Text(_label(option)),
              ],
            ),
          ),
      ],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        child: Text(
          _label(speed),
          style: theme.textTheme.labelLarge?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }

  static String _label(double speed) {
    final text = speed == speed.roundToDouble()
        ? speed.toStringAsFixed(0)
        : speed.toString();
    return '${text}x';
  }
}

class _SleepTimerButton extends StatelessWidget {
  const _SleepTimerButton({required this.until, required this.onSelected});

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
    final colors = Theme.of(context).colorScheme;
    final active = until != null;
    return PopupMenuButton<int>(
      tooltip: 'Sleep timer',
      onSelected: (minutes) =>
          onSelected(minutes == 0 ? null : Duration(minutes: minutes)),
      itemBuilder: (context) => [
        for (final option in _options)
          PopupMenuItem(value: option.minutes, child: Text(option.label)),
        if (active) const PopupMenuItem(value: 0, child: Text('Turn off')),
      ],
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Icon(
          active ? Icons.bedtime : Icons.bedtime_outlined,
          color: active ? colors.primary : null,
        ),
      ),
    );
  }
}
