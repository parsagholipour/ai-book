import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

enum _MessageAction { copy }

Future<void> showMessageActionsMenu({
  required BuildContext context,
  required Offset position,
  required String message,
}) async {
  final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
  if (overlay is! RenderBox) return;

  final action = await showMenu<_MessageAction>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: const [
      PopupMenuItem<_MessageAction>(
        value: _MessageAction.copy,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.copy_outlined),
            SizedBox(width: 12),
            Text('Copy'),
          ],
        ),
      ),
    ],
  );

  if (action != _MessageAction.copy) return;

  await Clipboard.setData(ClipboardData(text: message));
  if (!context.mounted) return;

  ScaffoldMessenger.of(
    context,
  ).showSnackBar(const SnackBar(content: Text('Message copied')));
}
