import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../billing/domain/billing_models.dart';
import '../../voice/presentation/character_cast_sheet.dart';
import '../domain/project_models.dart';
import 'project_export_actions.dart';

enum _BookAction { chat, call, listen, open, share }

/// One row of the menu: what it does, and to which file.
typedef _ExportChoice = ({_BookAction action, MobileExportAvailability export});

/// Long-press menu for a book on the shelf.
///
/// Mirrors [showMessageActionsMenu]: same `showMenu` at the pointer, same row
/// layout, so holding a book feels like holding a message.
///
/// Formats that have not been compiled yet stay visible but disabled — a book
/// mid-write should still show what will be there, rather than a menu whose
/// items appear and disappear as generation progresses. Formats that are ready
/// but not unlocked follow the export panel's rule: spend credits when the
/// balance covers it, and only open the paywall when it does not. A format the
/// plan does not include (the Word file) is offered with a lock and opens the
/// paywall; the server rules on the request either way.
Future<void> showBookActionsMenu({
  required BuildContext context,
  required WidgetRef ref,
  required Offset position,
  required MobileProjectSummary project,

  /// The account's billing state, or null when it has not loaded. Null keeps
  /// the credit-gated actions enabled and lets the server rule on the unlock,
  /// matching the export panel rather than guessing that the user cannot pay —
  /// and reads a plan-gated format as locked, matching the import tile.
  required MobileBilling? billing,
  VoidCallback? onRefresh,
}) async {
  final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
  if (overlay is! RenderBox) return;

  final credits = billing?.credits.available;
  final exports = project.exports.all;

  final action = await showMenu<Object>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: [
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
              Flexible(
                child: Text('Listen', overflow: TextOverflow.ellipsis),
              ),
            ],
          ),
        ),
      for (final export in exports)
        _bookActionItem(
          choice: (action: _BookAction.open, export: export),
          icon: projectExportIcon(export),
          billing: billing,
          credits: credits,
        ),
      for (final export in exports)
        _bookActionItem(
          choice: (action: _BookAction.share, export: export),
          icon: Icons.ios_share_outlined,
          billing: billing,
          credits: credits,
        ),
    ],
  );

  if (action == null || !context.mounted) return;

  // Chat is available throughout the book lifecycle and is unrelated to
  // export readiness or unlock credits.
  if (action == _BookAction.chat) {
    context.push('/projects/${project.id}/chat');
    return;
  }

  // Calls are metered per minute by the call screen itself, so they do not go
  // through the export unlock check below.
  if (action == _BookAction.call) {
    await showCharacterCastSheet(context: context, projectId: project.id);
    return;
  }

  // Narration is priced on its own screen, so it skips the export unlock too.
  if (action == _BookAction.listen) {
    context.push('/projects/${project.id}/listen');
    return;
  }

  final choice = action as _ExportChoice;
  final export = choice.export;

  // Same rule the export panel uses: a locked export still goes through when
  // the account can cover it — the download itself spends the credits. Only a
  // balance that cannot cover the unlock, or a plan the format needs, is sent
  // to the paywall.
  if (projectExportLockedBySubscription(export, billing) ||
      projectExportNeedsCredits(export, credits)) {
    await openProjectExportPaywall(
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
  required int? credits,
}) {
  final export = choice.export;
  final enabled = export.available;
  final lockedBySubscription = projectExportLockedBySubscription(
    export,
    billing,
  );
  final needsCredits = projectExportNeedsCredits(export, credits);
  // Open matches the tile: Upgrade / Get credits / Unlock / Open. Share only
  // borrows that helper when the plan is missing, so it does not become Open
  // or Unlock; otherwise it stays "Share Word".
  final label = choice.action == _BookAction.share && !lockedBySubscription
      ? 'Share ${projectExportFormatLabel(export)}'
      : projectExportDownloadLabel(
          export,
          needsCredits,
          lockedBySubscription: lockedBySubscription,
        );
  // The lock warns about a purchase or a plan, so it only shows when credits are
  // actually short or the plan is missing; a covered unlock is spent silently,
  // as elsewhere.
  final showLock = enabled && (needsCredits || lockedBySubscription);
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
