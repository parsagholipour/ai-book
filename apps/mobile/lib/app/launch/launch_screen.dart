import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/ui/app_components.dart';
import '../../shared/ui/motion.dart';
import 'launch_book_art.dart';

/// Shared by native-service startup and session restoration, so the first
/// Flutter frame is already the launch page. It never delays navigation.
class LaunchScreen extends StatefulWidget {
  const LaunchScreen({
    this.loadingMessage = 'Getting your library ready',
    this.slowMessage = 'Still connecting. This is taking longer than usual.',
    this.errorTitle = 'Connection problem',
    this.errorMessage,
    this.retrying = false,
    this.onRetry,
    super.key,
  });

  final String loadingMessage;
  final String slowMessage;
  final String errorTitle;
  final String? errorMessage;
  final bool retrying;
  final VoidCallback? onRetry;

  @override
  State<LaunchScreen> createState() => _LaunchScreenState();
}

class _LaunchScreenState extends State<LaunchScreen>
    with SingleTickerProviderStateMixin {
  static const _span = Duration(seconds: 30);
  late final _clock = AnimationController(vsync: this, duration: _span)
    ..forward();

  @override
  void didUpdateWidget(LaunchScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.retrying && !oldWidget.retrying) _clock.forward(from: 0);
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    return Scaffold(
      backgroundColor: theme.brightness == Brightness.light
          ? const Color(0xFFF8F5ED)
          : colors.surface,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxHeight < 650;
            // Leave room for the real status/action at large accessibility
            // sizes or in landscape; the illustration still carries the idea.
            final minimal =
                constraints.maxHeight < 440 ||
                MediaQuery.textScalerOf(context).scale(16) > 24;
            final padding = compact ? 24.0 : 36.0;
            return SingleChildScrollView(
              padding: EdgeInsets.symmetric(horizontal: 28, vertical: padding),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: math.max(0, constraints.maxHeight - padding * 2),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: TomezaWordmark(
                        markSize: 32,
                        textStyle: theme.textTheme.titleLarge?.copyWith(
                          fontSize: 24,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.8,
                        ),
                      ),
                    ),
                    Padding(
                      padding: EdgeInsets.symmetric(
                        vertical: compact ? 20 : 32,
                      ),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 420),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            SizedBox(
                              width: minimal
                                  ? 140
                                  : compact
                                  ? 200
                                  : 336,
                              child: AspectRatio(
                                aspectRatio: 320 / 270,
                                child: AnimatedBuilder(
                                  animation: _clock,
                                  builder: (context, _) => LaunchBookArt(
                                    reveal:
                                        reduced || widget.errorMessage != null
                                        ? 1
                                        : Curves.easeOutCubic.transform(
                                            (_clock.value *
                                                    _span.inMilliseconds /
                                                    650)
                                                .clamp(0.0, 1.0),
                                          ),
                                  ),
                                ),
                              ),
                            ),
                            if (!minimal) ...[
                              SizedBox(height: compact ? 16 : 28),
                              Semantics(
                                header: true,
                                child: Text.rich(
                                  TextSpan(
                                    children: [
                                      const TextSpan(text: 'A little idea.\n'),
                                      TextSpan(
                                        text: 'A book of your own.',
                                        style: TextStyle(
                                          color: colors.primary,
                                          fontStyle: FontStyle.italic,
                                        ),
                                      ),
                                    ],
                                  ),
                                  textAlign: TextAlign.center,
                                  style: theme.textTheme.headlineLarge
                                      ?.copyWith(
                                        fontFamily: 'NotoSerif',
                                        fontSize: compact ? 27 : 32,
                                        height: 1.3,
                                        letterSpacing: -1.0,
                                        fontWeight: FontWeight.w400,
                                      ),
                                ),
                              ),
                              const SizedBox(height: 14),
                              Text(
                                'Start with what’s on your mind.',
                                textAlign: TextAlign.center,
                                style: theme.textTheme.bodyLarge?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 360),
                      child: widget.errorMessage != null
                          ? _LaunchRetry(
                              title: widget.errorTitle,
                              message: widget.errorMessage!,
                              retrying: widget.retrying,
                              onRetry: widget.onRetry,
                            )
                          : AnimatedBuilder(
                              animation: _clock,
                              builder: (context, _) {
                                final elapsed =
                                    _clock.value * _span.inMilliseconds;
                                final slow = elapsed >= 6000;
                                final message = slow
                                    ? widget.slowMessage
                                    : widget.loadingMessage;
                                return Semantics(
                                  liveRegion: true,
                                  label: message,
                                  child: ExcludeSemantics(
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        _LaunchProgress(
                                          position: reduced
                                              ? 0.5
                                              : (elapsed % 1800) / 1800,
                                        ),
                                        const SizedBox(height: 16),
                                        Text(
                                          message,
                                          textAlign: TextAlign.center,
                                          style: theme.textTheme.bodySmall
                                              ?.copyWith(
                                                color: colors.onSurfaceVariant,
                                              ),
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _LaunchProgress extends StatelessWidget {
  const _LaunchProgress({required this.position});

  final double position;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      width: 112,
      height: 3,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: ColoredBox(
          color: colors.primary.withValues(alpha: 0.13),
          child: Align(
            alignment: Alignment(
              -1 + 2 * Curves.easeInOut.transform(position),
              0,
            ),
            child: SizedBox(
              width: 32,
              height: 3,
              child: ColoredBox(color: colors.primary),
            ),
          ),
        ),
      ),
    );
  }
}

class _LaunchRetry extends StatelessWidget {
  const _LaunchRetry({
    required this.title,
    required this.message,
    required this.retrying,
    required this.onRetry,
  });

  final String title;
  final String message;
  final bool retrying;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          liveRegion: true,
          header: true,
          child: Text(
            title,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (onRetry != null) ...[
          const SizedBox(height: 20),
          AppButton.primary(
            label: 'Retry',
            loading: retrying,
            loadingLabel: 'Retrying',
            expanded: true,
            leading: const Icon(Icons.refresh),
            onPressed: onRetry,
          ),
        ],
      ],
    );
  }
}
