import 'package:flutter/material.dart';

import '../domain/reader_annotation.dart';
import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_settings.dart';

/// One colour the reader can mark up in.
class ReaderMarkupColor {
  const ReaderMarkupColor(this.name, this.color);

  final String name;
  final Color color;
}

/// The markup palette.
///
/// Fixed colours rather than theme colours: markup sits on the printed page,
/// not on app chrome, and a highlight that changed hue with the app's theme
/// would stop being the yellow one the reader remembers. Only the ink entry
/// flips, because near-black on an inverted page is invisible.
///
/// [onDarkPage] is about the *page*, which follows the tint, not the app.
List<ReaderMarkupColor> readerMarkupPalette({required bool onDarkPage}) {
  return [
    const ReaderMarkupColor('Yellow', Color(0xFFFFD54F)),
    const ReaderMarkupColor('Green', Color(0xFF81C784)),
    const ReaderMarkupColor('Blue', Color(0xFF64B5F6)),
    const ReaderMarkupColor('Pink', Color(0xFFF06292)),
    ReaderMarkupColor(
      'Ink',
      onDarkPage ? const Color(0xFFECEFF1) : const Color(0xFF1F2933),
    ),
    const ReaderMarkupColor('Red', Color(0xFFE53935)),
  ];
}

/// The wash over a search hit, and over the one the reader is looking at.
///
/// pdfrx's defaults are a flat `Colors.yellow` and `Colors.orange`, and the
/// search wash is painted *after* the night tint has inverted the page — so on
/// a dark page they arrive at full saturation, which is exactly where a reader
/// least wants to be shouted at. These follow the page instead, and are kept
/// distinct enough that the current hit is obvious among its neighbours.
///
/// [onDarkPage] is about the *page*, which follows the tint, not the app.
Color readerSearchMatchColor({required bool onDarkPage}) {
  return onDarkPage ? const Color(0x4D64B5F6) : const Color(0x66FFD54F);
}

Color readerActiveSearchMatchColor({required bool onDarkPage}) {
  return onDarkPage ? const Color(0x9964B5F6) : const Color(0xB3FFB300);
}

/// Reads a stored colour index, tolerating one that no longer exists.
ReaderMarkupColor readerMarkupColor(
  List<ReaderMarkupColor> palette,
  int index,
) {
  if (index < 0 || index >= palette.length) {
    return palette.first;
  }
  return palette[index];
}

/// Tints the page.
///
/// Painted before any markup, so a highlight drawn afterwards keeps its own
/// colour instead of being tinted along with the paper.
void paintReaderPageTint(Canvas canvas, Rect pageRect, ReaderPageTint tint) {
  switch (tint) {
    case ReaderPageTint.none:
      return;
    case ReaderPageTint.sepia:
      canvas.drawRect(
        pageRect,
        Paint()
          ..color = const Color(0xFFF4E7CE)
          ..blendMode = BlendMode.multiply,
      );
    case ReaderPageTint.gray:
      canvas.drawRect(
        pageRect,
        Paint()
          ..color = const Color(0xFFE3E1DC)
          ..blendMode = BlendMode.multiply,
      );
    case ReaderPageTint.night:
      // Inverting the page is what actually makes a book readable in the dark;
      // a dark overlay only makes grey text on grey paper.
      canvas.drawRect(
        pageRect,
        Paint()
          ..color = const Color(0xFFFFFFFF)
          ..blendMode = BlendMode.difference,
      );
      // Knocks the hard white of the inverted type back to something that does
      // not glare in a dark room.
      canvas.drawRect(
        pageRect,
        Paint()
          ..color = const Color(0xFFCBD5DC)
          ..blendMode = BlendMode.multiply,
      );
  }
}

/// Draws a page's markup.
void paintReaderAnnotations({
  required Canvas canvas,
  required Rect pageRect,
  required List<ReaderAnnotation> annotations,
  required List<ReaderMarkupColor> palette,
  required bool onDarkPage,
}) {
  for (final annotation in annotations) {
    final color = readerMarkupColor(palette, annotation.colorIndex).color;
    switch (annotation) {
      case TextMarkupAnnotation(:final style, :final rects):
        _paintTextMarkup(
          canvas: canvas,
          pageRect: pageRect,
          rects: rects,
          style: style,
          color: color,
          onDarkPage: onDarkPage,
        );
      case NoteAnnotation(:final rects):
        // The pin is a widget; this is the passage it was taken on, marked
        // faintly so it is clear what the note is about.
        _paintTextMarkup(
          canvas: canvas,
          pageRect: pageRect,
          rects: rects,
          style: ReaderMarkupStyle.underline,
          color: color,
          onDarkPage: onDarkPage,
        );
      case InkAnnotation(:final strokes):
        for (final stroke in strokes) {
          paintInkStroke(
            canvas: canvas,
            pageRect: pageRect,
            stroke: stroke,
            color: readerMarkupColor(palette, stroke.colorIndex).color,
          );
        }
      case TextBoxAnnotation():
        // Rendered as a widget so it can be tapped and edited.
        break;
    }
  }
}

void _paintTextMarkup({
  required Canvas canvas,
  required Rect pageRect,
  required List<NormRect> rects,
  required ReaderMarkupStyle style,
  required Color color,
  required bool onDarkPage,
}) {
  if (rects.isEmpty) {
    return;
  }
  for (final norm in rects) {
    final rect = norm.toRect(pageRect);
    if (rect.isEmpty) {
      continue;
    }
    switch (style) {
      case ReaderMarkupStyle.highlight:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            rect.inflate(rect.height * 0.06),
            const Radius.circular(2),
          ),
          Paint()
            ..color = color.withValues(alpha: onDarkPage ? 0.42 : 0.38)
            // Multiply keeps the type legible through the colour. On an
            // inverted page it would drive everything to black, so the dark
            // page lightens instead.
            ..blendMode = onDarkPage ? BlendMode.screen : BlendMode.multiply,
        );
      case ReaderMarkupStyle.underline:
        final thickness = (rect.height * 0.075).clamp(1.0, 3.0);
        canvas.drawRect(
          Rect.fromLTWH(
            rect.left,
            rect.bottom - thickness,
            rect.width,
            thickness,
          ),
          Paint()..color = color.withValues(alpha: 0.9),
        );
      case ReaderMarkupStyle.strikethrough:
        final thickness = (rect.height * 0.07).clamp(1.0, 3.0);
        canvas.drawRect(
          Rect.fromLTWH(
            rect.left,
            rect.center.dy - thickness / 2,
            rect.width,
            thickness,
          ),
          Paint()..color = color.withValues(alpha: 0.9),
        );
    }
  }
}

/// Draws one pen stroke, smoothed.
///
/// Shared with the layer that draws the stroke still under the finger, so what
/// is being drawn and what has been committed look identical — otherwise the
/// line visibly changes shape the moment the finger lifts.
void paintInkStroke({
  required Canvas canvas,
  required Rect pageRect,
  required InkStroke stroke,
  required Color color,
}) {
  final points = stroke.points;
  if (points.isEmpty) {
    return;
  }
  final width = (stroke.width * pageRect.width).clamp(0.8, 64.0);
  final paint = Paint()
    ..color = color
    ..style = PaintingStyle.stroke
    ..strokeWidth = width
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..isAntiAlias = true;

  if (points.length == 1) {
    canvas.drawCircle(
      points.first.toOffset(pageRect),
      width / 2,
      Paint()..color = color,
    );
    return;
  }

  final path = Path();
  var previous = points.first.toOffset(pageRect);
  path.moveTo(previous.dx, previous.dy);
  for (var i = 1; i < points.length; i++) {
    final current = points[i].toOffset(pageRect);
    // Curving through the midpoints turns the sampled polyline back into
    // something that reads as handwriting rather than as a chain of segments.
    final mid = Offset(
      (previous.dx + current.dx) / 2,
      (previous.dy + current.dy) / 2,
    );
    path.quadraticBezierTo(previous.dx, previous.dy, mid.dx, mid.dy);
    previous = current;
  }
  path.lineTo(previous.dx, previous.dy);
  canvas.drawPath(path, paint);
}
