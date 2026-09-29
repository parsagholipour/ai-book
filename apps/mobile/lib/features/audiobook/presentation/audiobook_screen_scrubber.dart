part of 'audiobook_screen.dart';

/// One scrubber for the whole book.
///
/// The narrated part is a solid track and the part still being made is a
/// fainter one behind it, so the book's full length is visible from the first
/// minute without pretending it can all be played. Chapter starts are small
/// gaps in the track, which is what tells a listener how the hour is divided
/// before they have opened the chapter list.
class _BookScrubber extends StatefulWidget {
  const _BookScrubber({
    required this.positionMs,
    required this.totalMs,
    required this.playableMs,
    required this.chapters,
    required this.onSeek,
  });

  final int positionMs;
  final int totalMs;
  final int playableMs;
  final List<MobileAudiobookChapter> chapters;
  final void Function(int positionMs) onSeek;

  @override
  State<_BookScrubber> createState() => _BookScrubberState();
}

class _BookScrubberState extends State<_BookScrubber> {
  double? _dragValue;

  /// Chapter starts as fractions of the book, first chapter excluded: the start
  /// of the book is not a boundary anyone needs marked.
  List<double> _tickFractions(int total) {
    final ticks = <double>[];
    var running = 0;
    for (final (position, chapter) in widget.chapters.indexed) {
      if (position > 0 && total > 0) {
        ticks.add(running / total);
      }
      running += chapter.effectiveDurationMs;
    }
    return ticks;
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final total = widget.totalMs <= 0 ? 1 : widget.totalMs;
    final value = (_dragValue ?? widget.positionMs.toDouble()).clamp(
      0,
      total.toDouble(),
    );

    return SizedBox(
      height: 44,
      child: SliderTheme(
        data: SliderTheme.of(context).copyWith(
          trackHeight: 5,
          trackShape: _BookTrackShape(
            playableFraction: (widget.playableMs / total).clamp(0.0, 1.0),
            tickFractions: _tickFractions(total),
            gapColor: colors.surfaceContainerLow,
            playableColor: colors.primary.withValues(alpha: 0.26),
            trackColor: colors.outlineVariant,
          ),
          activeTrackColor: colors.primary,
          thumbColor: colors.primary,
          overlayColor: colors.primary.withValues(alpha: 0.12),
          thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
          overlayShape: const RoundSliderOverlayShape(overlayRadius: 20),
        ),
        child: Slider(
          value: value.toDouble(),
          max: total.toDouble(),
          semanticFormatterCallback: (position) =>
              '${_spoken(position.round())} of ${_spoken(total)}',
          onChanged: (next) => setState(() => _dragValue = next),
          onChangeEnd: (next) {
            setState(() => _dragValue = null);
            AppHaptics.selection();
            widget.onSeek(next.round());
          },
        ),
      ),
    );
  }

  /// "1 hour 20 minutes 4 seconds": what a screen reader should say for a
  /// position, rather than a percentage of a book nobody has the length of.
  static String _spoken(int milliseconds) {
    final totalSeconds = (milliseconds / 1000).round();
    final hours = totalSeconds ~/ 3600;
    final minutes = (totalSeconds % 3600) ~/ 60;
    final seconds = totalSeconds % 60;
    String unit(int n, String word) => '$n $word${n == 1 ? '' : 's'}';
    return [
      if (hours > 0) unit(hours, 'hour'),
      if (minutes > 0) unit(minutes, 'minute'),
      if (seconds > 0 || (hours == 0 && minutes == 0)) unit(seconds, 'second'),
    ].join(' ');
  }
}

/// Draws the whole scrubber track: the length of the book, the part that is
/// narrated, the part already listened to, and a gap at each chapter start.
///
/// Painted here rather than stacked behind a transparent slider so the four
/// layers share one geometry — including in right-to-left layouts, where the
/// slider itself is mirrored and a second widget behind it would not be.
class _BookTrackShape extends SliderTrackShape with BaseSliderTrackShape {
  const _BookTrackShape({
    required this.playableFraction,
    required this.tickFractions,
    required this.gapColor,
    required this.playableColor,
    required this.trackColor,
  });

  final double playableFraction;
  final List<double> tickFractions;
  final Color gapColor;
  final Color playableColor;
  final Color trackColor;

  @override
  void paint(
    PaintingContext context,
    Offset offset, {
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required Animation<double> enableAnimation,
    required Offset thumbCenter,
    Offset? secondaryOffset,
    bool isEnabled = false,
    bool isDiscrete = false,
    required TextDirection textDirection,
    double additionalActiveTrackHeight = 2,
  }) {
    final rect = getPreferredRect(
      parentBox: parentBox,
      offset: offset,
      sliderTheme: sliderTheme,
      isEnabled: isEnabled,
      isDiscrete: isDiscrete,
    );
    final canvas = context.canvas;
    final radius = Radius.circular(rect.height / 2);
    final rtl = textDirection == TextDirection.rtl;

    double at(double fraction) => rtl
        ? rect.right - rect.width * fraction
        : rect.left + rect.width * fraction;
    Rect between(double from, double to) => Rect.fromLTRB(
      math.min(from, to),
      rect.top,
      math.max(from, to),
      rect.bottom,
    );

    canvas.save();
    canvas.clipRRect(RRect.fromRectAndRadius(rect, radius));
    canvas.drawRect(rect, Paint()..color = trackColor);
    canvas.drawRect(
      between(at(0), at(playableFraction)),
      Paint()..color = playableColor,
    );
    // Where the listener is: from the start of the book to the thumb.
    canvas.drawRect(
      between(at(0), thumbCenter.dx),
      Paint()..color = sliderTheme.activeTrackColor ?? playableColor,
    );

    // A gap only where there is room for one, so a book of sixty chapters
    // reads as a fine texture rather than a comb.
    var lastX = double.negativeInfinity;
    final gap = Paint()..color = gapColor;
    for (final fraction in tickFractions) {
      final x = at(fraction);
      if ((x - lastX).abs() < 7) {
        continue;
      }
      lastX = x;
      canvas.drawRect(
        Rect.fromCenter(
          center: Offset(x, rect.center.dy),
          width: 2.5,
          height: rect.height,
        ),
        gap,
      );
    }
    canvas.restore();
  }
}
