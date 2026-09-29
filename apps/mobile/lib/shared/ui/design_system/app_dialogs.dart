import 'package:flutter/material.dart';

import 'app_buttons.dart';
import 'app_tokens.dart';

class AppConfirmationDialog extends StatelessWidget {
  const AppConfirmationDialog({
    required this.title,
    required this.confirmLabel,
    this.message,
    this.cancelLabel = 'Cancel',
    this.destructive = false,
    this.icon,
    super.key,
  });

  final String title;
  final String? message;
  final String confirmLabel;
  final String cancelLabel;
  final bool destructive;

  /// A glyph above the title. A destructive dialog with no icon of its own
  /// gets a warning triangle, so the danger is not carried by a red button
  /// alone.
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context);
    final glyph = icon ?? (destructive ? Icons.warning_amber_rounded : null);
    // Dialog buttons sit side by side, so the taller 52dp form used for a
    // page's call to action would make Cancel (48) and Confirm (52) uneven.
    final compactFilled = FilledButton.styleFrom(
      minimumSize: const Size(64, AppSizes.minimumTouchTarget),
    );
    return Theme(
      data: theme.copyWith(
        filledButtonTheme: FilledButtonThemeData(
          style: theme.filledButtonTheme.style?.merge(compactFilled),
        ),
      ),
      child: AlertDialog(
        icon: glyph == null ? null : Icon(glyph),
        iconColor: destructive ? colors.error : colors.primary,
        title: Text(title),
        content: message == null ? null : Text(message!),
        // A long confirm label or a large text size drops the primary action
        // under Cancel instead of overflowing the dialog.
        actionsOverflowDirection: VerticalDirection.down,
        actionsOverflowButtonSpacing: AppSpacing.xs,
        actions: [
          AppButton.text(
            label: cancelLabel,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          if (destructive)
            AppButton.destructive(
              label: confirmLabel,
              onPressed: () => Navigator.of(context).pop(true),
            )
          else
            AppButton.primary(
              label: confirmLabel,
              onPressed: () => Navigator.of(context).pop(true),
            ),
        ],
      ),
    );
  }
}

Future<bool> showAppConfirmationDialog(
  BuildContext context, {
  required String title,
  required String confirmLabel,
  String? message,
  String cancelLabel = 'Cancel',
  bool destructive = false,
  IconData? icon,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AppConfirmationDialog(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      cancelLabel: cancelLabel,
      destructive: destructive,
      icon: icon,
    ),
  );
  return result ?? false;
}
