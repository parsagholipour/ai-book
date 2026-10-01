part of 'manuscript_emphasis.dart';

// ---------------------------------------------------------------------------
// A keyboard one edit behind
// ---------------------------------------------------------------------------

/// The keyboard's edits, made on the text it last sent, moved onto the text
/// the formatters turned that into.
///
/// On Android the engine keeps its own copy of the text, the keyboard edits
/// that copy, and every edit goes to the framework as the whole new text. The
/// formatters here rewrite text behind the cursor — `**S**` round the first
/// letter of a bold word, closing marks moved past the next word, a list
/// marker added on Enter — and the rewrite reaches the engine's copy only
/// after a round trip. A keyboard typing faster than that (`adb shell input
/// text` always does) makes its next edit on the copy without the rewrite, and
/// read against the rewritten text that edit is not "one letter typed" but
/// marks deleted and words moved: on the phone a bold phrase came back as
/// `**She smiled a**t **everyone that night.****`.
///
/// So the value the keyboard last sent is kept, and an edit that is a plain
/// edit at the caret of *that* value — and not of the current one — is made
/// again at the current caret, with the composing region carried along. This
/// formatter has to run first, before anything reads the edit.
class ManuscriptImeRebase extends TextInputFormatter {
  TextEditingValue? _sent;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final sent = _sent;
    _sent = newValue;
    if (sent == null || sent.text == oldValue.text) return newValue;
    return rebaseKeyboardEdit(sent: sent, current: oldValue, next: newValue) ??
        newValue;
  }
}

/// [next], which the keyboard made from [sent], made instead on [current] —
/// what the formatters turned [sent] into. Null when [next] is already an edit
/// of [current], or is not an edit at [sent]'s caret that can be moved.
TextEditingValue? rebaseKeyboardEdit({
  required TextEditingValue sent,
  required TextEditingValue current,
  required TextEditingValue next,
}) {
  if (_caretEdit(current, next) != null) return null;
  final now = current.selection;
  final was = sent.selection;
  if (!now.isValid || !now.isCollapsed || !was.isValid || !was.isCollapsed) {
    return null;
  }
  // How far the rewrite moved the caret: everything the keyboard touched sits
  // just behind it, in both texts.
  final shift = now.baseOffset - was.baseOffset;
  bool sameText(int from, int to) =>
      from + shift >= 0 &&
      to + shift <= current.text.length &&
      current.text.substring(from + shift, to + shift) ==
          sent.text.substring(from, to);

  TextRange carried(TextRange composing, String text) {
    if (!composing.isValid || composing.isCollapsed) return TextRange.empty;
    final moved = TextRange(
      start: composing.start + shift,
      end: composing.end + shift,
    );
    if (moved.start < 0 || moved.end > text.length) return TextRange.empty;
    return moved;
  }

  if (next.text == sent.text) {
    // The keyboard finished or moved its composing word, nothing more.
    final composing = carried(next.composing, current.text);
    if (!composing.isCollapsed &&
        !sameText(next.composing.start, next.composing.end)) {
      return null;
    }
    final caret = next.selection.isValid && next.selection.isCollapsed
        ? next.selection.baseOffset + shift
        : now.baseOffset;
    if (caret < 0 || caret > current.text.length) return null;
    return TextEditingValue(
      text: current.text,
      selection: TextSelection.collapsed(offset: caret),
      composing: composing,
    );
  }

  final change = _caretEdit(sent, next);
  if (change == null || !sameText(change.start, change.end)) return null;
  final start = change.start + shift;
  final text = current.text.replaceRange(
    start,
    change.end + shift,
    change.inserted,
  );
  // Offsets of [next] past the edit sit in [text] by the same shift: the edit
  // replaced the same letters in both.
  final caret = next.selection.isValid && next.selection.isCollapsed
      ? next.selection.baseOffset + shift
      : start + change.inserted.length;
  final composing = next.composing;
  var moved = carried(composing, text);
  if (!moved.isCollapsed) {
    final before = composing.start < change.start
        ? sameText(composing.start, change.start)
        : true;
    if (!before) moved = TextRange.empty;
  }
  if (caret < 0 || caret > text.length) return null;
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: caret),
    composing: moved,
  );
}

/// The edit that turned [base] into [next], when it is one a keyboard makes at
/// the caret: text typed there, letters before it deleted, or the composing
/// word ending there replaced.
_Change? _caretEdit(TextEditingValue base, TextEditingValue next) {
  final selection = base.selection;
  if (!selection.isValid || !selection.isCollapsed) return null;
  final change = _changeOf(base, next);
  if (change == null) return null;
  final caret = selection.baseOffset;
  if (change.end != caret) return null;
  if (change.start == caret) return change;
  final composing = base.composing;
  final reach = composing.isValid && !composing.isCollapsed
      ? composing.start
      : caret;
  // A deletion before the caret, or a rewrite of the composing word.
  if (change.inserted.isEmpty || change.start >= reach) return change;
  return null;
}
