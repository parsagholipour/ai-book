import 'package:flutter/material.dart';

import '../motion.dart';
import 'app_tokens.dart';

const _actionSheetMaxHeightRatio = 9 / 16;

/// Opens an application modal sheet with the shared route behavior.
///
/// Sheet contents keep ownership of their layout, including feature-specific
/// maximum heights and keyboard padding. The launcher owns the route-level
/// scroll and safe-area contract so every sheet can grow to the available
/// height without entering system UI. Sheets that would rather not lay
/// themselves out can use [AppSheetScaffold], which does the header, the
/// scrolling body, the keyboard and the pinned footer.
Future<T?> showAppBottomSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  bool enableDrag = true,
  bool? showDragHandle,
  bool isDismissible = true,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    enableDrag: enableDrag,
    isDismissible: isDismissible,
    showDragHandle: showDragHandle,
    builder: (sheetContext) =>
        SafeArea(top: false, child: builder(sheetContext)),
  );
}

/// Opens a compact, vertically scrollable menu that returns an action.
///
/// The action itself stays feature-owned; action menus do not need to share a
/// data model just to share presentation behavior. A [title] adds the standard
/// sheet header above the rows.
Future<T?> showAppActionSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  String? title,
}) {
  return showAppBottomSheet<T>(
    context,
    builder: (sheetContext) {
      final mediaQuery = MediaQuery.of(sheetContext);
      final maxContentHeight =
          mediaQuery.size.height * _actionSheetMaxHeightRatio -
          kMinInteractiveDimension -
          mediaQuery.padding.bottom;
      return ConstrainedBox(
        // Account for the themed drag handle and bottom safe area so the whole
        // menu keeps Flutter's ordinary modal-sheet maximum. Editors and other
        // long-form sheets can use the full height through [showAppBottomSheet].
        constraints: BoxConstraints(
          maxHeight: maxContentHeight.clamp(0, double.infinity),
        ),
        child: SingleChildScrollView(
          child: title == null
              ? builder(sheetContext)
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    AppSheetHeader(title: title),
                    builder(sheetContext),
                  ],
                ),
        ),
      );
    },
  );
}

/// The heading every sheet opens with: a title, an optional line beneath it,
/// an optional leading glyph, and room at the end for one action.
///
/// It sits under the drag handle the theme draws, so its own top padding is
/// small. Pass [onClose] for a sheet that is a task rather than a menu, so
/// there is a visible way out besides the drag and the barrier.
class AppSheetHeader extends StatelessWidget {
  const AppSheetHeader({
    required this.title,
    this.subtitle,
    this.icon,
    this.trailing,
    this.onClose,
    this.padding = const EdgeInsetsDirectional.fromSTEB(
      AppSpacing.lg - AppSpacing.xxs,
      AppSpacing.xxs,
      AppSpacing.lg - AppSpacing.xxs,
      AppSpacing.sm,
    ),
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;

  /// One action at the end of the row (a text button, a badge). Ignored when
  /// [onClose] is set.
  final Widget? trailing;
  final VoidCallback? onClose;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final end =
        trailing ??
        (onClose == null
            ? null
            : IconButton(
                onPressed: onClose,
                tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                icon: const Icon(Icons.close),
              ));
    return Padding(
      padding: padding,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (icon != null) ...[
            ExcludeSemantics(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: colors.primaryContainer.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(AppRadii.compact),
                ),
                child: SizedBox.square(
                  dimension: 40,
                  child: Icon(icon, color: colors.primary, size: 22),
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    style: text.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (end != null) ...[const SizedBox(width: AppSpacing.xs), end],
        ],
      ),
    );
  }
}

/// A complete sheet body: [AppSheetHeader], a scrolling middle, and an
/// optional footer pinned below it.
///
/// It handles what every sheet has had to reinvent: it lifts above the
/// keyboard (easing as the keyboard moves), caps its height so a long body
/// scrolls rather than pushing the header off screen, and keeps the footer,
/// usually the primary action, in view however long the body gets. Launch it
/// with [showAppBottomSheet].
class AppSheetScaffold extends StatelessWidget {
  const AppSheetScaffold({
    required this.title,
    required this.children,
    this.subtitle,
    this.icon,
    this.headerTrailing,
    this.onClose,
    this.footer,
    this.maxHeightFactor = 0.9,
    this.bodyPadding = const EdgeInsetsDirectional.fromSTEB(
      AppSpacing.lg - AppSpacing.xxs,
      0,
      AppSpacing.lg - AppSpacing.xxs,
      AppSpacing.md,
    ),
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? headerTrailing;
  final VoidCallback? onClose;

  /// The scrolling content.
  final List<Widget> children;

  /// Pinned under the body, above the keyboard and the safe area.
  final Widget? footer;

  /// The tallest the sheet gets, as a share of the screen.
  final double maxHeightFactor;
  final EdgeInsetsGeometry bodyPadding;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final keyboard = media.viewInsets.bottom;
    final maxHeight = (media.size.height * maxHeightFactor - keyboard).clamp(
      0.0,
      double.infinity,
    );
    return AnimatedPadding(
      duration: AppMotion.adapt(context, AppMotion.fast),
      curve: AppMotion.enter,
      padding: EdgeInsets.only(bottom: keyboard),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppSheetHeader(
              title: title,
              subtitle: subtitle,
              icon: icon,
              trailing: headerTrailing,
              onClose: onClose,
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: bodyPadding,
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: children,
                ),
              ),
            ),
            if (footer != null)
              DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(
                    AppSpacing.lg - AppSpacing.xxs,
                    AppSpacing.sm,
                    AppSpacing.lg - AppSpacing.xxs,
                    AppSpacing.md,
                  ),
                  child: footer,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
