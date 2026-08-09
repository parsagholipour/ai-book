import 'package:flutter/material.dart';

import 'app_buttons.dart';

class AppConfirmationDialog extends StatelessWidget {
  const AppConfirmationDialog({
    required this.title,
    required this.message,
    required this.confirmLabel,
    this.cancelLabel = 'Cancel',
    this.destructive = false,
    super.key,
  });

  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(title),
      content: Text(message),
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
    );
  }
}

Future<bool> showAppConfirmationDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AppConfirmationDialog(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      cancelLabel: cancelLabel,
      destructive: destructive,
    ),
  );
  return result ?? false;
}
