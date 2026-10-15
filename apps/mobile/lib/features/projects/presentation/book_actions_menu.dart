import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../billing/domain/billing_models.dart';
import '../../studio/presentation/studio_location.dart';
import '../../voice/presentation/character_cast_sheet.dart';
import '../domain/project_models.dart';
import 'project_export_actions.dart';

enum _BookAction { write, chat, call, listen, open, share }

/// One row of the menu: what it does, and to which file.
typedef _ExportChoice = ({_BookAction action, MobileExportAvailability export});

/// Long-press menu for a book on the shelf.
///
/// Mirrors [showMessageActionsMenu]: same `showMenu` at the pointer, same row
/// layout, so holding a book feels like holding a message.
///
/// Formats that have not been compiled yet stay visible but disabled — a book
/// mid-write should still show what will be there, rather than a menu whose
/// items appear and disappear as generation progresses. A ready PDF or EPUB
/// opens or shares straight away: a written book's files download free. A
/// format the plan does not include (the Word file) is offered with a lock and
/// opens the plan offer; the server rules on the request either way.
Future<void> showBookActionsMenu({
  required BuildContext context,
  required WidgetRef ref,
  required Offset position,
  required MobileProjectSummary project,

  /// The account's billing state, or null when it has not loaded. Null reads a
  /// plan-gated format as locked, matching the import tile.
  required MobileBilling? billing,
  VoidCallback? onRefresh,
}) async {
  final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
  if (overlay is! RenderBox) return;

  // A manuscript the author has not published has no chat to go to and no
  // files coming until they publish it; the one thing to do is keep writing.
  final unpublished = project.isUnpublishedManuscript;
  final exports = unpublished
      ? const <MobileExportAvailability>[]
      : project.exports.all;

  final action = await showMenu<Object>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: [
      // The author owns this text, so Edit is the Writing Studio whether or
      // not it has been published; a published one also has its book chat.
      if (project.isAuthorManuscript)
        const PopupMenuItem<Object>(
          value: _BookAction.write,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.edit_outlined),
              SizedBox(width: 12),
              Flexible(
                child: Text('Keep writing', overflow: TextOverflow.ellipsis),
              ),
            ],
          ),
        ),
      if (!unpublished)
        const PopupMenuItem<Object>(
          value: _BookAction.chat,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.chat_bubble_outline),
              SizedBox(width: 12),
              Flexible(
                child: Text('Go to chat', overflow: TextOverflow.ellipsis),
              ),
            ],
          ),
        ),
      // Characters only exist for a finished book, so unlike the export items
      // this one is hidden rather than disabled: there is nothing to promise.
      if (project.status == 'complete')
        const PopupMenuItem<Object>(
          value: _BookAction.call,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.record_voice_over_outlined),
              SizedBox(width: 12),
              Flexible(
                child: Text(
                  'Talk to characters',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      // Narration, like characters, needs a finished book to exist at all.
      if (project.status == 'complete')
        const PopupMenuItem<Object>(
          value: _BookAction.listen,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.headphones_outlined),
              SizedBox(width: 12),
              Flexible(child: Text('Listen', overflow: TextOverflow.ellipsis)),
            ],
          ),
        ),
      for (final export in exports)
        _bookActionItem(
          choice: (action: _BookAction.open, export: export),
          icon: projectExportIcon(export),
          billing: billing,
        ),
      for (final export in exports)
        _bookActionItem(
          choice: (action: _BookAction.share, export: export),
          icon: Icons.ios_share_outlined,
          billing: billing,
        ),
    ],
  );

  if (action == null || !context.mounted) return;

  if (action == _BookAction.write) {
    context.push(studioLocation(project.id));
    return;
  }

  // Chat is available throughout the book lifecycle and is unrelated to
  // export readiness.
  if (action == _BookAction.chat) {
    context.push('/projects/${project.id}/chat');
    return;
  }

  // Calls are metered per minute by the call screen itself.
  if (action == _BookAction.call) {
    await showCharacterCastSheet(context: context, projectId: project.id);
    return;
  }

  // Narration is priced on its own screen.
  if (action == _BookAction.listen) {
    context.push('/projects/${project.id}/listen');
    return;
  }

  final choice = action as _ExportChoice;
  final export = choice.export;

  // Same rule the export panel uses: only a format the plan does not include
  // goes to the plan offer; everything else is the file.
  if (projectExportLockedBySubscription(export, billing)) {
    await openProjectExportPlanOffer(
      context: context,
      ref: ref,
      projectId: project.id,
      export: export,
      isMounted: () => context.mounted,
      onRefresh: onRefresh,
    );
    return;
  }

  switch (choice.action) {
    case _BookAction.open:
      await openProjectExport(
        context: context,
        ref: ref,
        projectId: project.id,
        export: export,
        isMounted: () => context.mounted,
        onRefresh: onRefresh,
      );
    case _BookAction.share:
      await downloadProjectExport(
        context: context,
        ref: ref,
        projectId: project.id,
        export: export,
        isMounted: () => context.mounted,
        onRefresh: onRefresh,
      );
    case _BookAction.write:
    case _BookAction.chat:
    case _BookAction.call:
    case _BookAction.listen:
      // Handled above because none of them requires an export.
      return;
  }
}

PopupMenuItem<Object> _bookActionItem({
  required _ExportChoice choice,
  required IconData icon,
  required MobileBilling? billing,
}) {
  final export = choice.export;
  final enabled = export.available;
  final lockedBySubscription = projectExportLockedBySubscription(
    export,
    billing,
  );
  // Open matches the tile: Upgrade / Open. Share only borrows that helper when
  // the plan is missing, so it does not become Open; otherwise it stays
  // "Share Word".
  final label = choice.action == _BookAction.share && !lockedBySubscription
      ? 'Share ${projectExportFormatLabel(export)}'
      : projectExportDownloadLabel(
          export,
          lockedBySubscription: lockedBySubscription,
        );
  // The lock marks the one plan-only format; a PDF or EPUB has none.
  final showLock = enabled && lockedBySubscription;
  return PopupMenuItem<Object>(
    value: choice,
    enabled: enabled,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon),
        const SizedBox(width: 12),
        // Flexible so the longer states ("preparing") and large text scales
        // shrink instead of overflowing the menu row. The download helper
        // already says "Preparing PDF"; do not append the suffix onto that.
        Flexible(
          child: Text(
            enabled || label.startsWith('Preparing ')
                ? label
                : '$label — preparing',
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (showLock) ...[
          const SizedBox(width: 8),
          const Icon(Icons.lock_outline, size: 16),
        ],
      ],
    ),
  );
}
