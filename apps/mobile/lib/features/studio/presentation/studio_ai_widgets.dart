import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/plan_build_progress.dart'
    show PlanBuildProgressBar, PlanBuildSparkle;
import 'studio_ai_billing.dart';

/// How far along a wait reads [elapsed] in. The server reports no finer
/// progress than "working", so like the Build button this paces its own: an
/// ease toward a ceiling it never reaches, quick at first, slower after.
double pacedAssistProgress(
  Duration elapsed, {
  Duration tau = const Duration(seconds: 8),
}) {
  const floor = 0.04;
  const ceiling = 0.92;
  final t = elapsed.inMilliseconds / tau.inMilliseconds;
  return ceiling - (ceiling - floor) * math.exp(-t);
}

/// The stage [elapsed] in: one step every [studioAiStageInterval], never
/// back, settling on the last.
String assistStageLabel(Duration elapsed, List<String> stages) {
  final index = elapsed.inMilliseconds ~/ studioAiStageInterval.inMilliseconds;
  return stages[index.clamp(0, stages.length - 1)];
}

const Duration studioAiStageInterval = Duration(milliseconds: 3500);

/// The writing assistant at work: a sparkle, what it is doing now in honest
/// words, and a bar that only climbs. Never a bare spinner.
class StudioAiWaiting extends StatefulWidget {
  const StudioAiWaiting({
    required this.stages,
    this.note,
    this.tau = const Duration(seconds: 8),
    this.compact = false,
    this.padding = const EdgeInsets.symmetric(vertical: AppSpacing.lg),
    super.key,
  });

  /// What is happening, in order: "Reading your chapter…", then more.
  final List<String> stages;

  /// A quiet line beneath, such as where the result will wait.
  final String? note;

  /// How long the wait usually is: the bar's pace.
  final Duration tau;

  /// A row for a card rather than a block for a sheet.
  final bool compact;

  /// Room above and below the block (a card gives it less than a sheet).
  final EdgeInsetsGeometry padding;

  @override
  State<StudioAiWaiting> createState() => _StudioAiWaitingState();
}

class _StudioAiWaitingState extends State<StudioAiWaiting>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;

  /// Frame time since the wait began — the scheduler's clock, so a test that
  /// pumps a duration moves it.
  Duration _clock = Duration.zero;
  double _shown = 0;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick)..start();
  }

  void _tick(Duration elapsed) {
    // Reduced motion keeps the reading honest without a per-frame repaint.
    if (AppMotion.reducedMotion(context) &&
        elapsed.inSeconds == _clock.inSeconds) {
      return;
    }
    setState(() => _clock = elapsed);
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
    _shown = math.max(_shown, pacedAssistProgress(_clock, tau: widget.tau));
    final stage = assistStageLabel(_clock, widget.stages);
    final bar = PlanBuildProgressBar(
      value: _shown,
      height: widget.compact ? 5 : 6,
      semanticLabel: stage,
    );
    if (widget.compact) {
      return Row(
        children: [
          PlanBuildSparkle(color: colors.primary, size: 18),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  stage,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 6),
                bar,
              ],
            ),
          ),
        ],
      );
    }
    return Padding(
      padding: widget.padding,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              color: colors.primaryContainer.withValues(alpha: 0.55),
              shape: BoxShape.circle,
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: PlanBuildSparkle(color: colors.primary, size: 30),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          AnimatedSwitcher(
            duration: AppMotion.adapt(context, AppMotion.medium),
            child: Text(
              stage,
              key: ValueKey(stage),
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 260),
            child: bar,
          ),
          if (widget.note != null) ...[
            const SizedBox(height: AppSpacing.md),
            Text(
              widget.note!,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The one tap that spends credits: its label carries the price ("Create
/// picture · 45 credits"), it waits for the price before it can be pressed,
/// and it answers a refusal about money with the app's own sheets — then,
/// after a purchase, says the author can go on rather than closing on the
/// same dead end.
class StudioPaidButton<T> extends ConsumerStatefulWidget {
  const StudioPaidButton({
    required this.projectId,
    required this.label,
    required this.credits,
    required this.start,
    required this.onStarted,
    required this.reason,
    this.enabled = true,
    super.key,
  });

  final String projectId;

  /// What the tap does: "Create picture".
  final String label;

  /// Null while the price is loading.
  final int? credits;

  /// Starts the paid work. Throws the server's refusal.
  final Future<T> Function() start;
  final ValueChanged<T> onStarted;

  /// What the credits buy, for the credits-needed sheet.
  final String reason;
  final bool enabled;

  @override
  ConsumerState<StudioPaidButton<T>> createState() =>
      _StudioPaidButtonState<T>();
}

class _StudioPaidButtonState<T> extends ConsumerState<StudioPaidButton<T>> {
  bool _busy = false;
  String? _error;
  String? _note;

  Future<void> _press() async {
    setState(() {
      _busy = true;
      _error = null;
      _note = null;
    });
    try {
      final result = await widget.start();
      if (!mounted) return;
      setState(() => _busy = false);
      widget.onStarted(result);
    } catch (error) {
      if (!mounted) return;
      setState(() => _busy = false);
      final recovery = await answerStudioBillingRefusal(
        context,
        ref,
        error,
        projectId: widget.projectId,
        reason: widget.reason,
      );
      if (!mounted) return;
      setState(() {
        switch (recovery) {
          case StudioAiRecovery.ready:
            _note = 'You’re all set. Tap ${widget.label} to go on.';
          case StudioAiRecovery.blocked:
            break;
          case StudioAiRecovery.none:
            _error = studioAiErrorMessage(error);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final credits = widget.credits;
    final failed =
        credits == null && watchStudioPriceFailed(ref, widget.projectId);
    final label = credits == null
        ? (failed ? widget.label : 'Checking the price…')
        : '${widget.label} · ${studioCredits(credits)}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_note != null || _error != null || failed)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xs),
            child: Text(
              _note ??
                  _error ??
                  'The price couldn’t be loaded, so this can’t start yet.',
              key: const ValueKey('studio-paid-message'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: _note != null ? colors.primary : colors.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        if (failed)
          AppButton.outlined(
            label: 'Try loading the price again',
            expanded: true,
            onPressed: () => retryStudioPrice(ref, widget.projectId),
          )
        else
          AppButton.primary(
            key: const ValueKey('studio-paid-button'),
            label: label,
            expanded: true,
            loading: _busy,
            loadingLabel: 'Starting…',
            onPressed: widget.enabled && credits != null && !_busy
                ? () => unawaited(_press())
                : null,
          ),
      ],
    );
  }
}

/// A small heading over a group of tools or results.
class StudioAiSectionLabel extends StatelessWidget {
  const StudioAiSectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xs, bottom: AppSpacing.xs),
      child: Text(
        text.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.primary,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.1,
        ),
      ),
    );
  }
}

/// A result's actions on one line — the quiet ones at the start, the one
/// that changes the text filling the rest — so the suggestion above keeps
/// the room. Stacked where the line is too narrow or the text too large.
class StudioAiActionRow extends StatelessWidget {
  const StudioAiActionRow({
    required this.primary,
    this.secondary = const [],
    super.key,
  });

  final Widget primary;
  final List<Widget> secondary;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        if (constraints.maxWidth < 320 || textScale >= 1.3) {
          return AppActionGroup(primary: primary, secondary: secondary);
        }
        return Row(
          children: [
            for (final action in secondary) ...[
              action,
              const SizedBox(width: AppSpacing.xs),
            ],
            if (secondary.isNotEmpty) const SizedBox(width: AppSpacing.xxs),
            Expanded(child: primary),
          ],
        );
      },
    );
  }
}
