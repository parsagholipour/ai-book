# Writing Studio (the editor)

The author's writing surface. Each text segment of a chapter is a `StudioTextField`
(`presentation/studio_editor.dart`) over a `ManuscriptEditingController`, which draws markdown as it
will read in the book without changing a character of it. This file is about what that costs: two
things the framework's text field does not do for you.

## Bold and italic have no visible marks

- **A hidden mark is still a character, so the cursor, the keyboard and the buttons all have to be
  taught that it is not there.** `**bold**` is drawn as bold with the stars at font size 0, but the
  stars are in the text — the saved markdown, the selection offsets and the undo history are all that
  text. Every offset beside a mark looks the same on screen, and every key press there can break a
  mark nobody can see (a lone `*` reappears as literal text). The rules are in
  `domain/manuscript_emphasis*.dart`, all pure functions of a `TextEditingValue`:
  the cursor never rests strictly inside a mark (`snapSelection`, applied by the controller's
  `value` setter, so a tap, a drag, an arrow key and a programmatic set all go through it);
  backspace and Delete next to a mark take the letter beside it; deleting one end of a bold word
  keeps the rest bold and deleting the last letter takes the marks; a space at the end of a bold word
  goes after it and Enter inside one ends the bold and starts it again (marks cannot cross a line).
  Edits are corrected by `ManuscriptEmphasisFormatter`, which **the field must be given** — a new
  field over this controller needs `controller.emphasisFormatter` in `inputFormatters`, after the
  Enter formatter, or the marks are unprotected.
- **Styling and editing read one parse.** `domain/manuscript_inline.dart` is the only place that
  knows what a mark is; the styler walks its tree and the editing rules read its pairs
  (`EmphasisIndex`). Do not add a second scanner for `*` — two of them disagree about `snake_case`,
  `***both***` and code fences, and the disagreement shows up as a star you cannot see or delete.
  Only bold and italic are hidden. Strikethrough, code ticks, link brackets, `#` and `>` stay faint
  and visible, and are not `EmphasisPair`s.
- **A step over a mark is exactly one character.** `snapSelection` treats a caret that moved one
  character from an edge of a hidden run to inside it (or to its other edge) as an arrow key and
  carries on past the next visible letter, because a step that moved nothing you can see looks like a
  dead key. A jump of any other size is a tap and goes to the run's near edge, which keeps the style
  of the letter before it. Widening "one" to "any distance" makes a tap on the caret's own spot skip a
  letter.
- **Bold with nothing selected is a typing style, not text.** With the cursor between words the
  button writes nothing (`ManuscriptEditingController.toggleStyle`); the marks go round the next
  thing typed, and the style is dropped when the cursor moves or the text changes. Writing `****` and
  parking the cursor inside it was the old behaviour: with marks hidden it shows as a scene break.
  The toolbar's lit state (`isStyleOn`) is the only sign left that the style is on.
- **The buttons act on what is seen.** `toggleEmphasis` normalises a selection past hidden marks
  first, so dragging over `**bold**` and getting only its opening stars still unwraps it; a part of a
  bold run loses bold and the rest keeps it; a mixed selection becomes all bold. Counting stars
  around the selection cannot do any of these once the stars are invisible.

## The caret

- **A blank line is short, and the field's caret arithmetic assumes it is not.** A paragraph break is
  a blank line drawn at 0.84 of the font size (`ManuscriptSpanPalette.blankStyleFor`), which is
  what makes paragraph spacing. `RenderEditable` centres the caret on a *strut box* at the line's
  baseline, and puts the caret on the empty line after a trailing newline "a standard line" above
  that baseline, where the standard line is the root span's. With a 1px strut and the body style as
  root both were wrong: the caret sat 7px low on text and ~20px above the line after Enter (the
  complaint was "the cursor is a bit higher"). `ManuscriptCaret` explains the fix and
  `test/features/studio/studio_caret_test.dart` pins it in the real font at two text scales.
- **Short lines get their height from negative even leading, not a smaller font.** With
  `TextLeadingDistribution.even` the baseline stays near the bottom of a short line, so the caret's
  centre is the centre of whatever line it is on. A smaller font with proportional leading puts it
  ~2.6px low on text lines and no `TextField` argument can move it (only `EditableText` has
  `cursorOffset`). The strut, the blank line's newline and the root span must all be that one style,
  and every line of text must be taller than it, or the field's own formulas stop agreeing.
- **The caret is short on a blank line and full height on text.** A full-height caret on a half-height
  line pokes into the paragraph above. It grows when the first letter lands. `cursorHeight` is in
  logical pixels and is not scaled, so it is measured with the field's text scaler.
