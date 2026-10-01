import 'package:flutter/material.dart';

import 'manuscript_editing_controller.dart' show ManuscriptSpanPalette;

/// Where the field draws its caret, so it sits on the line being written.
///
/// A blank line is drawn at about half height (see the controller), which the
/// field does not expect. It centres the caret on a strut box at the line's
/// baseline, and puts the caret at the end of the text — on the empty line
/// after a paragraph break — a "standard line" above the last baseline. With
/// the body's own line as that standard both come out right on a text line and
/// wrong everywhere else, so the standard is the blank line instead: the strut
/// and the root span are a blank line's size, every text line is taller than
/// them, and the field's caret arithmetic agrees with itself.
///
/// A blank line keeps its baseline near its bottom (negative *even* leading,
/// see [ManuscriptSpanPalette.blankStyleFor]), which makes the caret's centre
/// the centre of the line it is on, blank or not. A caret the height of a text
/// line would poke out of a blank one, so on an empty line it is the height of
/// the line and grows to full height when the first letter lands.
@immutable
class ManuscriptCaret {
  const ManuscriptCaret({required this.height, required this.emptyLineHeight});

  /// Measures the caret for a field whose text is [body], at [scaler].
  factory ManuscriptCaret.measure({
    required TextStyle body,
    required TextScaler scaler,
    required TextDirection textDirection,
  }) {
    final strut = ManuscriptSpanPalette.strutFor(
      body,
    ).inheritFromTextStyle(body);
    TextPainter measure(TextStyle style) => TextPainter(
      text: TextSpan(text: 'A', style: style),
      textDirection: textDirection,
      textScaler: scaler,
      strutStyle: strut,
    )..layout();
    final bodyLine = measure(body);
    final blankLine = measure(ManuscriptSpanPalette.blankStyleFor(body));
    final caret = ManuscriptCaret(
      // What a stock text field draws: the line, less the field's own 2px
      // inset at each end.
      height: bodyLine.height - 4,
      emptyLineHeight: blankLine.height,
    );
    bodyLine.dispose();
    blankLine.dispose();
    return caret;
  }

  /// The caret on a line of text.
  final double height;

  /// The caret on a blank line.
  final double emptyLineHeight;

  /// The caret's height with the cursor where [value] puts it.
  ///
  /// An empty chapter is not a blank line: its one line is as tall as the
  /// text that will fill it.
  double heightFor(TextEditingValue value) =>
      value.text.isNotEmpty && caretOnEmptyLine(value)
      ? emptyLineHeight
      : height;

  @override
  bool operator ==(Object other) =>
      other is ManuscriptCaret &&
      other.height == height &&
      other.emptyLineHeight == emptyLineHeight;

  @override
  int get hashCode => Object.hash(height, emptyLineHeight);
}

/// Whether [value] is a cursor on a line with nothing on it: the empty last
/// line after a paragraph break, an empty chapter, or a blank line between two
/// paragraphs.
bool caretOnEmptyLine(TextEditingValue value) {
  final selection = value.selection;
  if (!selection.isValid || !selection.isCollapsed) return false;
  final text = value.text;
  final at = selection.baseOffset.clamp(0, text.length);
  return (at == 0 || text.codeUnitAt(at - 1) == 0x0a) &&
      (at == text.length || text.codeUnitAt(at) == 0x0a);
}
