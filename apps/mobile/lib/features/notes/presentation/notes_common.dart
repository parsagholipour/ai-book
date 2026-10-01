import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/chat_text_direction.dart';
import '../data/book_notes_repository.dart';
import '../domain/book_note.dart';

/// The book's title, if a screen already has it — never a fetch of its own.
///
/// The notes are opened from the book page or the Studio, and both have the
/// book loaded; a deep link that has neither simply shows no title.
String? watchNotesBookTitle(WidgetRef ref, String projectId) {
  final detail = projectDetailProvider(projectId);
  if (ref.exists(detail)) {
    final title = ref.watch(detail.select((value) => value.value?.title));
    if (title != null && title.trim().isNotEmpty) return title.trim();
  }
  if (ref.exists(projectsProvider)) {
    final title = ref.watch(
      projectsProvider.select((value) {
        for (final book in value.value ?? const []) {
          if (book.id == projectId) return book.title;
        }
        return null;
      }),
    );
    if (title != null && title.trim().isNotEmpty) return title.trim();
  }
  return null;
}

/// [parts] read aloud as sentences: a part that already ends its sentence
/// keeps its own mark, so a note ending "…at dusk." is not followed by "..".
String noteSemanticsLabel(Iterable<String> parts) {
  final ended = RegExp(r'[.!?…。؟]$');
  final buffer = StringBuffer();
  for (final part in parts) {
    final text = part.trim();
    if (text.isEmpty) continue;
    if (buffer.isNotEmpty) {
      if (!ended.hasMatch(buffer.toString())) buffer.write('.');
      buffer.write(' ');
    }
    buffer.write(text);
  }
  return buffer.toString();
}

/// The direction [text] reads in, when it says; null keeps the app's own.
TextDirection? noteTextDirection(String text) {
  return switch (chatTextDirection(text)) {
    TextDirectionHint.rtl => TextDirection.rtl,
    TextDirectionHint.ltr => TextDirection.ltr,
    null => null,
  };
}

/// A two-line app bar title: what the screen is, and a quieter line under it.
///
/// Its text scale is capped so a large setting grows the words without
/// pushing them out of the bar.
class NotesBarTitle extends StatelessWidget {
  const NotesBarTitle({required this.title, this.subtitle, super.key});

  final Widget title;
  final Widget? subtitle;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.4,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [title, ?subtitle],
      ),
    );
  }
}

/// One row of a notes menu: a glyph and a label.
class NotesMenuRow extends StatelessWidget {
  const NotesMenuRow({
    required this.icon,
    required this.label,
    this.destructive = false,
    super.key,
  });

  final IconData icon;
  final String label;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final color = destructive ? colors.error : colors.onSurfaceVariant;
    return Row(
      children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(width: AppSpacing.sm),
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: destructive ? TextStyle(color: colors.error) : null,
          ),
        ),
      ],
    );
  }
}

/// Deletes a note and offers it back.
///
/// [stored] is the server's note to delete, or null when it never reached
/// the server. [restore] is what Undo writes back — the words on screen,
/// which may be newer than [stored]. The server deletes for good, so Undo
/// makes a new note with the same title, body and pin.
///
/// Everything here goes through [messenger] and [actions], which outlive the
/// screen that asked: the editor closes before the message shows.
Future<void> deleteBookNoteWithUndo({
  required ScaffoldMessengerState messenger,
  required BookNotesActions actions,
  required String projectId,
  required BookNote? stored,
  required BookNoteDraft restore,
}) async {
  AppHaptics.tap();
  final deletion = stored == null
      ? Future<bool>.value(true)
      : actions.delete(projectId, stored).then<bool>((_) => true).catchError((
          Object error,
        ) {
          messenger.hideCurrentSnackBar();
          messenger.showAppSnackBar(
            SnackBar(
              content: Text(
                'Could not delete the note. ${userFacingError(error)}',
              ),
            ),
          );
          return false;
        });
  final worthKeeping =
      restore.title.trim().isNotEmpty || restore.body.trim().isNotEmpty;
  messenger.hideCurrentSnackBar();
  messenger.showAppSnackBar(
    SnackBar(
      content: const Text('Note deleted'),
      // Undo is for the moment after; a bar that waits to be dismissed would
      // sit over the list for no reason.
      persist: false,
      duration: const Duration(seconds: 6),
      action: worthKeeping
          ? SnackBarAction(
              label: 'Undo',
              onPressed: () => unawaited(() async {
                if (!await deletion) return;
                await _restore(
                  messenger: messenger,
                  actions: actions,
                  projectId: projectId,
                  draft: restore,
                  requestId: newBookNoteRequestId(),
                );
              }()),
            )
          : null,
    ),
  );
  await deletion;
}

Future<void> _restore({
  required ScaffoldMessengerState messenger,
  required BookNotesActions actions,
  required String projectId,
  required BookNoteDraft draft,
  required String requestId,
}) async {
  try {
    await actions.restore(projectId, draft, requestId: requestId);
    AppHaptics.selection();
  } catch (error) {
    messenger.hideCurrentSnackBar();
    messenger.showAppSnackBar(
      SnackBar(
        content: Text(
          'Could not bring the note back. ${userFacingError(error)}',
        ),
        action: SnackBarAction(
          label: 'Try again',
          // The same request id: a restore that did land is not made twice.
          onPressed: () => unawaited(
            _restore(
              messenger: messenger,
              actions: actions,
              projectId: projectId,
              draft: draft,
              requestId: requestId,
            ),
          ),
        ),
      ),
    );
  }
}
