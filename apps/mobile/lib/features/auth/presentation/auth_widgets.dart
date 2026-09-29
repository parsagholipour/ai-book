import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';

/// Below this much room the brand header collapses to a one-line lockup: a
/// short phone, a landscape phone, or a tall one with the keyboard up. The form
/// is what the reader came for, and a 72dp logo tile is not worth a scroll.
const double _compactBodyHeight = 680;

/// The frame every signed-out screen shares: a brand-tinted wash behind a
/// scrolling, width-capped column.
///
/// [builder] is told whether the screen is short so the screen can drop
/// decoration rather than push its own primary action off the fold. The column
/// scrolls under the keyboard and dismisses it on drag, so no field is ever
/// hidden behind it and nothing overflows at large text sizes.
class AuthPageShell extends StatelessWidget {
  const AuthPageShell({
    required this.builder,
    this.appBar,
    this.maxWidth = 440,
    this.alignment = Alignment.center,
    super.key,
  });

  final List<Widget> Function(BuildContext context, bool compact) builder;
  final PreferredSizeWidget? appBar;
  final double maxWidth;

  /// Where the column sits when the screen is taller than it is. A flow with
  /// steps stays at the top so its first line does not move between steps.
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    // The wash is a gradient over a solid: a BoxDecoration with a gradient
    // ignores its own colour, so the surface has to be a layer of its own.
    return ColoredBox(
      color: colors.surface,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: const Alignment(0, 0.1),
            colors: [
              colors.primary.withValues(alpha: 0.11),
              colors.primary.withValues(alpha: 0),
            ],
          ),
        ),
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: appBar,
          body: SafeArea(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final compact = constraints.maxHeight < _compactBodyHeight;
                const vertical = AppSpacing.md + AppSpacing.lg;
                return SingleChildScrollView(
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  padding: const EdgeInsetsDirectional.fromSTEB(
                    AppSpacing.lg,
                    AppSpacing.md,
                    AppSpacing.lg,
                    AppSpacing.lg,
                  ),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      minHeight: (constraints.maxHeight - vertical).clamp(
                        0,
                        double.infinity,
                      ),
                    ),
                    child: Align(
                      alignment: alignment,
                      child: ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: maxWidth),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: builder(context, compact),
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Logo mark, name and the one-line promise. [compact] keeps only the lockup.
class AuthBrandHeader extends StatelessWidget {
  const AuthBrandHeader({required this.compact, super.key});

  final bool compact;

  static const promise = 'Practical books for creators and teachers.';

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.medium;

    Widget tile(double size) => ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: colors.primaryContainer,
          borderRadius: BorderRadius.circular(size * 0.3),
        ),
        child: TomezaBrandMark(color: colors.primary, size: size * 0.7),
      ),
    );

    final Widget header = compact
        ? Row(
            key: const ValueKey('auth-header-compact'),
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              tile(40),
              const SizedBox(width: AppSpacing.sm),
              Flexible(
                child: Text(
                  'Tomeza',
                  style: text.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          )
        : Column(
            key: const ValueKey('auth-header-full'),
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(child: tile(72)),
              const SizedBox(height: AppSpacing.md),
              Text(
                'Tomeza',
                textAlign: TextAlign.center,
                style: text.displaySmall?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: AppSpacing.xxs),
              Text(
                promise,
                textAlign: TextAlign.center,
                style: text.bodyLarge?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
          );

    return AnimatedSize(
      duration: duration,
      curve: AppMotion.standard,
      alignment: Alignment.topCenter,
      child: AnimatedSwitcher(duration: duration, child: header),
    );
  }
}

/// A screen title with the sentence beneath it that says what to do here.
class AuthHeading extends StatelessWidget {
  const AuthHeading({required this.title, required this.subtitle, super.key});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            title,
            style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
        ),
        const SizedBox(height: AppSpacing.xxs),
        Text(
          subtitle,
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
      ],
    );
  }
}
