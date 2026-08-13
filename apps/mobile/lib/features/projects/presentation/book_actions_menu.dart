import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../voice/presentation/character_cast_sheet.dart';
import '../domain/project_models.dart';
import 'project_export_actions.dart';

enum _BookAction { chat, call, listen, openPdf, openEpub, sharePdf, shareEpub }

/// Long-press menu for a book on the shelf.
///
/// Mirrors [showMessageActionsMenu]: same `showMenu` at the pointer, same row
/// layout, so holding a book feels like holding a message.
///
/// Formats that have not been compiled yet stay visible but disabled — a book
/// mid-write should still show what will be there, rather than a menu whose
/// items appear and disappear as generation progresses. Formats that are ready
/// but not unlocked follow the export panel's rule: spend credits when the
/// balance covers it, and only open the paywall when it does not.
Future<void> showBookActionsMenu({
  required BuildContext context,
  required WidgetRef ref,
  required Offset position,
  required MobileProjectSummary project,

  /// Spendable credits, or null when the balance has not loaded. Null keeps
  /// the action enabled and lets the server rule on the unlock, matching the
  /// export panel rather than guessing that the user cannot pay.
  required int? credits,
  VoidCallback? onRefresh,
}) async {
  final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
  if (overlay is! RenderBox) return;

  final pdf = project.exports.pdf;
  final epub = project.exports.epub;

  final action = await showMenu<_BookAction>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: [
      const PopupMenuItem<_BookAction>(
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
        const PopupMenuItem<_BookAction>(
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
        const PopupMenuItem(
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
      _bookActionItem(
        value: _BookAction.openPdf,
        icon: Icons.picture_as_pdf_outlined,
        label: 'Open PDF',
        export: pdf,
        credits: credits,
      ),
      _bookActionItem(
        value: _BookAction.openEpub,
        icon: Icons.menu_book_outlined,
        label: 'Open EPUB',
        export: epub,
        credits: credits,
      ),
      _bookActionItem(
        value: _BookAction.sharePdf,
        icon: Icons.ios_share_outlined,
        label: 'Share PDF',
        export: pdf,
        credits: credits,
      ),
      _bookActionItem(
        value: _BookAction.shareEpub,
        icon: Icons.ios_share_outlined,
        label: 'Share EPUB',
        export: epub,
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

  final export = switch (action) {
    _BookAction.openPdf || _BookAction.sharePdf => pdf,
    _BookAction.openEpub || _BookAction.shareEpub => epub,
    _BookAction.chat || _BookAction.call || _BookAction.listen => throw StateError(
      'Chat, calls and listening are handled before export actions',
    ),
  };

  // Same rule the export panel uses: a locked export still goes through when
  // the account can cover it — the download itself spends the credits. Only a
  // balance that cannot cover the unlock is sent to the paywall.
  if (projectExportNeedsCredits(export, credits)) {
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

  switch (action) {
    case _BookAction.chat:
    case _BookAction.call:
    case _BookAction.listen:
      // Handled above because none of them requires an export.
      return;
    case _BookAction.openPdf:
    case _BookAction.openEpub:
      await openProjectExport(
        context: context,
        ref: ref,
        projectId: project.id,
        export: export,
        isMounted: () => context.mounted,
        onRefresh: onRefresh,
      );
    case _BookAction.sharePdf:
    case _BookAction.shareEpub:
      await downloadProjectExport(
        context: context,
        ref: ref,
        projectId: project.id,
        export: export,
        isMounted: () => context.mounted,
        onRefresh: onRefresh,
      );
  }
}

PopupMenuItem<_BookAction> _bookActionItem({
  required _BookAction value,
  required IconData icon,
  required String label,
  required MobileExportAvailability export,
  required int? credits,
}) {
  final enabled = export.available;
  // The lock warns about a purchase, so it only shows when credits are
  // actually short; a covered unlock is spent silently, as elsewhere.
  final showLock = enabled && projectExportNeedsCredits(export, credits);
  return PopupMenuItem<_BookAction>(
    value: value,
    enabled: enabled,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon),
        const SizedBox(width: 12),
        // Flexible so the longer states ("preparing") and large text scales
        // shrink instead of overflowing the menu row.
        Flexible(
          child: Text(
            enabled ? label : '$label — preparing',
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
