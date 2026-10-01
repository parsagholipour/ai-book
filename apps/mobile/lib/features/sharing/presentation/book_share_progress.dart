import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../shared/ui/design_system/app_tokens.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/plan_build_progress.dart';

// The share button while a save is in flight.
//
// A save that changed the note waits on a moderation model — several seconds
// with nothing to report — and one that did not is a blink. Neither reports
// progress, so the button paces its own the way the Build button does
// (`plan_build_progress.dart`): the fill eases toward a ceiling it never
// reaches, the line beneath the sparkle names the step the server is on, and
// the last line is the one it settles on — so a slow note is never described
// as a link being made while it is still being read.

/// Which steps a save takes, in the order the server takes them.
///
/// [checkingBook] is a create or a change of mode (the server screens the
/// book's text for both); [checkingNote] is a note that differs from the one
/// on the share, which is the only thing that is moderated.
List<String> bookShareSavingStages({
  required bool creating,
  required bool checkingBook,
  required bool checkingNote,
}) {
  return [
    if (checkingBook) 'Checking your book…',
    if (checkingNote) ...['Checking your note…', 'Still checking your note…'],
    if (!checkingNote)
      creating ? 'Creating your link…' : 'Saving your changes…',
  ];
}

const Duration bookShareStageInterval = Duration(milliseconds: 2500);

/// The step shown [elapsed] into a save: one every [bookShareStageInterval],
/// settling on the last.
String bookShareStageAt(Duration elapsed, List<String> stages) {
  final index = elapsed.inMilliseconds ~/ bookShareStageInterval.inMilliseconds;
  return stages[index.clamp(0, stages.length - 1)];
}

/// How full the button reads [elapsed] into a save: an exponential approach
/// to a ceiling below the end, slower when a model is reading the note.
double pacedBookShareProgress(Duration elapsed, {required bool slow}) {
  const floor = 0.04;
  const ceiling = 0.92;
  final tau = slow ? 5000 : 1200;
  return ceiling - (ceiling - floor) * math.exp(-elapsed.inMilliseconds / tau);
}

class BookShareSavingProgress extends StatefulWidget {
  const BookShareSavingProgress({
    required this.stages,
    this.slow = false,
    super.key,
  });

  final List<String> stages;

  /// A note is being moderated: pace for seconds rather than a moment.
  final bool slow;

  @override
  State<BookShareSavingProgress> createState() =>
      _BookShareSavingProgressState();
}

class _BookShareSavingProgressState extends State<BookShareSavingProgress>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;

  /// Frame time since the button appeared — the scheduler's clock, so a test
  /// that pumps a duration moves it.
  Duration _clock = Duration.zero;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((elapsed) => setState(() => _clock = elapsed))
      ..start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final progress = pacedBookShareProgress(_clock, slow: widget.slow);
    final percent = (progress * 100).round();
    final stage = bookShareStageAt(_clock, widget.stages);
    final labelStyle = theme.textTheme.labelLarge?.copyWith(
      color: colors.onPrimary,
      fontWeight: FontWeight.w700,
    );
    final fill = AnimatedFractionallySizedBox(
      duration: AppMotion.adapt(context, AppMotion.fast),
      alignment: AlignmentDirectional.centerStart,
      widthFactor: progress,
      // White rather than onPrimary, as on the Build button: in the dark theme
      // onPrimary is dark ink, and a band of it reads as the pill emptying.
      child: ColoredBox(color: Colors.white.withValues(alpha: 0.16)),
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Sharing your book. $stage',
      value: '${(percent / 5).round() * 5} percent',
      child: ExcludeSemantics(
        child: ClipRRect(
          key: const ValueKey('book-share-saving'),
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: Stack(
            children: [
              Positioned.fill(child: ColoredBox(color: colors.primary)),
              Positioned.fill(child: fill),
              ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.controlHeight,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  child: Row(
                    children: [
                      PlanBuildSparkle(color: colors.onPrimary, size: 22),
                      const SizedBox(width: 10),
                      Expanded(
                        child: ClipRect(
                          child: RisingStatusText(
                            text: stage,
                            style: labelStyle,
                            maxLines: 1,
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        '$percent%',
                        style: labelStyle?.copyWith(
                          fontWeight: FontWeight.w800,
                          fontFeatures: const [ui.FontFeature.tabularFigures()],
                        ),
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
