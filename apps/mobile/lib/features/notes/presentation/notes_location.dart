/// Where a book's notes live, and what every door into them shares.
library;

import 'package:flutter/material.dart' show IconData, Icons;

/// The one glyph for a book's notes, everywhere they are offered. (The
/// Studio's per-chapter notes use a different one, so the two never read as
/// the same thing.)
const IconData bookNotesIcon = Icons.sticky_note_2_outlined;

/// [bookNotesIcon], filled: a selected or emphasised notes control.
const IconData bookNotesIconFilled = Icons.sticky_note_2;

/// The note id a route uses for a note that does not exist yet. It is only
/// created on the server once something has been written in it.
const newBookNoteId = 'new';

/// A book's notes: `/projects/<id>/notes`.
String bookNotesLocation(String projectId) => '/projects/$projectId/notes';

/// One note: `/projects/<id>/notes/<noteId>`. [newBookNoteId] opens a blank
/// one.
String bookNoteLocation(String projectId, String noteId) =>
    '/projects/$projectId/notes/${Uri.encodeComponent(noteId)}';

/// A blank note on [projectId].
String newBookNoteLocation(String projectId) =>
    bookNoteLocation(projectId, newBookNoteId);
