import 'dart:async';

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/reader_models.dart';

/// Where the reader is, kept on the page while the bars are away.
///
/// Hiding the controls should not also hide the only answer to "how far
/// through am I?". This is that answer, as small as it can be: the chapter and
/// a `12 / 48`, in a pill at the foot of the page. It rests at a fraction of its
/// strength once the page has stopped moving and comes back to full when the
/// reader turns one, so it is there to glance at and never asks to be looked at.
///
/// It is also the way back. Tapping it brings the bars up, which is the same
/// thing a tap on the page does — so someone who cannot tap the page (a screen
/// reader, a switch) has a labelled control that does it for them.
class ReaderPageBadge extends StatefulWidget {
  const ReaderPageBadge({
    required this.visible,
    required this.currentPage,
    required this.pageCount,
    required this.onTap,
    this.chapterTitle,
    this.hasCoverPage = false,
    this.onDarkPage = false,
    super.key,
  });

  /// True while the bars are put away. Otherwise the bottom bar says all of
  /// this already, in more words.
  final bool visible;

  final int currentPage;
  final int pageCount;

  /// Whether PDF sheet 1 is an unnumbered cover. Displayed numbers skip it.
  final bool hasCoverPage;
  final String? chapterTitle;

  /// Whether the page under it is dark — the night tint — which is about the
  /// page and not about the app's theme, so the pill follows it. A pale pill on
  /// an inverted page is the brightest thing on screen.
  final bool onDarkPage;

  final VoidCallback onTap;

  /// How long the badge stays at full strength after the page last changed.
  static const restAfter = Duration(milliseconds: 2500);

  /// How strong it is at rest.
  static const restingOpacity = 0.55;

  /// `12 / 48` in printed numbers, or `Cover`.
  static String positionLabel(
    int page,
    int pageCount, {
    required bool hasCoverPage,
  }) {
    if (hasCoverPage && page == 1) return 'Cover';
    final printed = printedPageForPdfPage(page, hasCoverPage: hasCoverPage);
    final total = printedPageCount(pageCount, hasCoverPage: hasCoverPage);
    return '${printed ?? page} / $total';
  }

  @override
  State<ReaderPageBadge> createState() => _ReaderPageBadgeState();
}

class _ReaderPageBadgeState extends State<ReaderPageBadge> {
  Timer? _rest;
  bool _resting = false;

  @override
  void initState() {
    super.initState();
    if (widget.visible) _wake();
  }

  @override
  void didUpdateWidget(ReaderPageBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    final appeared = widget.visible && !oldWidget.visible;
    if (appeared ||
        (widget.visible && oldWidget.currentPage != widget.currentPage)) {
      _wake();
    }
  }

  @override
  void dispose() {
    _rest?.cancel();
    super.dispose();
  }

  /// Back to full strength, and the countdown to resting starts over.
  void _wake() {
    _rest?.cancel();
    _resting = false;
    _rest = Timer(ReaderPageBadge.restAfter, () {
      if (mounted) setState(() => _resting = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final visible = widget.visible;
    final known = widget.pageCount > 0;
    final reduced = AppMotion.reducedMotion(context);
    final duration = reduced ? Duration.zero : AppMotion.medium;
    // Before the viewer has said how long the book is there is no position to
    // state, but the way back to the controls must not depend on it.
    final position = known
        ? ReaderPageBadge.positionLabel(
            widget.currentPage.clamp(1, widget.pageCount),
            widget.pageCount,
            hasCoverPage: widget.hasCoverPage,
          )
        : 'Show controls';

    return IgnorePointer(
      ignoring: !visible,
      child: ExcludeSemantics(
        excluding: !visible,
        child: AnimatedOpacity(
          opacity: !visible
              ? 0
              : _resting
              ? ReaderPageBadge.restingOpacity
              : 1,
          duration: duration,
          curve: visible ? AppMotion.enter : AppMotion.exit,
          child: Semantics(
            button: true,
            label: 'Show controls',
            value: position,
            excludeSemantics: true,
            onTap: widget.onTap,
            child: Tooltip(
              message: 'Show controls',
              excludeFromSemantics: true,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: widget.onTap,
                // The pill is small; the target around it is not.
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minWidth: AppSizes.minimumTouchTarget,
                    minHeight: AppSizes.minimumTouchTarget,
                  ),
                  child: Center(child: _pill(context, position)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _pill(BuildContext context, String position) {
    final theme = Theme.of(context);
    final dark = widget.onDarkPage;
    final background = dark
        ? const Color(0xE61A1D21)
        : theme.colorScheme.surface;
    final foreground = dark
        ? const Color(0xFFCBD5DC)
        : theme.colorScheme.onSurfaceVariant;
    final chapter = widget.chapterTitle;
    final style = theme.textTheme.labelMedium?.copyWith(color: foreground);
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxWidth: (MediaQuery.sizeOf(context).width - 96).clamp(120.0, 340.0),
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(AppRadii.pill),
          border: Border.all(
            color: dark
                ? const Color(0x33CBD5DC)
                : theme.colorScheme.outlineVariant,
          ),
        ),
        child: Padding(
          padding: const EdgeInsetsDirectional.symmetric(
            horizontal: AppSpacing.sm,
            vertical: 6,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (chapter != null && chapter.isNotEmpty) ...[
                Flexible(
                  child: Text(
                    chapter,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: style,
                  ),
                ),
                Padding(
                  padding: const EdgeInsetsDirectional.symmetric(
                    horizontal: AppSpacing.xs,
                  ),
                  child: Text('·', style: style),
                ),
              ],
              Text(
                position,
                maxLines: 1,
                style: style?.copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
