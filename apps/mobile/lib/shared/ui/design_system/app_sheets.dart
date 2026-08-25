import 'package:flutter/material.dart';

const _actionSheetMaxHeightRatio = 9 / 16;

/// Opens an application modal sheet with the shared route behavior.
///
/// Sheet contents keep ownership of their layout, including feature-specific
/// maximum heights and keyboard padding. The launcher owns the route-level
/// scroll and safe-area contract so every sheet can grow to the available
/// height without entering system UI.
Future<T?> showAppBottomSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (sheetContext) =>
        SafeArea(top: false, child: builder(sheetContext)),
  );
}

/// Opens a compact, vertically scrollable menu that returns an action.
///
/// The action itself stays feature-owned; action menus do not need to share a
/// data model just to share presentation behavior.
Future<T?> showAppActionSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
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
        child: SingleChildScrollView(child: builder(sheetContext)),
      );
    },
  );
}
