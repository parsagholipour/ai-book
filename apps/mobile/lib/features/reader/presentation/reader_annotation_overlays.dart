import 'package:flutter/material.dart';
import '../domain/reader_annotation.dart';
import 'reader_annotation_painter.dart';

/// The markup on one page that has to be tapped rather than merely drawn.
///
/// Highlights and ink are painted straight onto the page canvas, which is much
/// cheaper; notes and text boxes are widgets because they carry text, need a
/// hit target and open an editor.
///
/// Nothing here takes a tap. `ReaderTapLayer` hit-tests the whole page against
/// the annotation model instead, so one thing decides what a tap on a page
/// means — a highlight, a drawing, a pin, or the chrome getting out of the way.
/// Two independent tap owners over the same pixels is how you get a note that
/// opens *and* hides the toolbar.
class ReaderPageAnnotationOverlay extends StatelessWidget {
  const ReaderPageAnnotationOverlay({
    required this.annotations,
    required this.palette,
    super.key,
  });

  final List<ReaderAnnotation> annotations;
  final List<ReaderMarkupColor> palette;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final height = constraints.maxHeight;
        if (width <= 0 || height <= 0) {
          return const SizedBox.shrink();
        }
        final children = <Widget>[];
        for (final annotation in annotations) {
          final color = readerMarkupColor(palette, annotation.colorIndex).color;
          switch (annotation) {
            case NoteAnnotation():
              children.add(
                _NotePin(
                  annotation: annotation,
                  color: color,
                  pageWidth: width,
                  pageHeight: height,
                ),
              );
            case TextBoxAnnotation():
              children.add(
                _TextBox(
                  annotation: annotation,
                  color: color,
                  pageWidth: width,
                  pageHeight: height,
                ),
              );
            case TextMarkupAnnotation():
            case InkAnnotation():
              break;
          }
        }
        if (children.isEmpty) {
          return const SizedBox.shrink();
        }
        return Stack(children: children);
      },
    );
  }
}

class _NotePin extends StatelessWidget {
  const _NotePin({
    required this.annotation,
    required this.color,
    required this.pageWidth,
    required this.pageHeight,
  });

  final NoteAnnotation annotation;
  final Color color;
  final double pageWidth;
  final double pageHeight;

  @override
  Widget build(BuildContext context) {
    // Scales with the page so a pin keeps its place in the margin at any zoom,
    // but never shrinks below something a finger can find. The floor is why the
    // drawn pin can be wider than the anchor reserved for it on a small screen,
    // and why the left edge is clamped rather than trusted.
    final size = (pageWidth * NoteAnnotation.pinSize).clamp(22.0, 44.0);
    final left = (annotation.anchor.x * pageWidth).clamp(
      0.0,
      (pageWidth - size).clamp(0.0, pageWidth),
    );
    final top = (annotation.anchor.y * pageHeight).clamp(
      0.0,
      pageHeight - size,
    );

    return Positioned(
      left: left,
      top: top,
      width: size,
      height: size,
      child: IgnorePointer(
        child: Opacity(
          // Sits over the page rather than beside it, so it stays legible
          // without competing with the words for attention.
          opacity: pinOpacity,
          child: Semantics(
            button: true,
            label: 'Note: ${annotation.preview}',
            child: Tooltip(
              message: annotation.preview,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x33000000),
                      blurRadius: 4,
                      offset: Offset(0, 1),
                    ),
                  ],
                ),
                child: Icon(
                  Icons.sticky_note_2_outlined,
                  size: size * 0.58,
                  color: _readableOn(color),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TextBox extends StatelessWidget {
  const _TextBox({
    required this.annotation,
    required this.color,
    required this.pageWidth,
    required this.pageHeight,
  });

  final TextBoxAnnotation annotation;
  final Color color;
  final double pageWidth;
  final double pageHeight;

  @override
  Widget build(BuildContext context) {
    final width = (annotation.widthFraction * pageWidth).clamp(
      48.0,
      pageWidth,
    );
    final left = (annotation.anchor.x * pageWidth).clamp(0.0, pageWidth - width);
    final top = (annotation.anchor.y * pageHeight).clamp(0.0, pageHeight);
    // Sized against the page rather than the screen, so the text keeps the same
    // relationship to the book's own type however far it is zoomed in.
    final fontSize = (pageWidth * 0.026 * annotation.fontScale).clamp(
      7.0,
      48.0,
    );

    return Positioned(
      left: left,
      top: top,
      width: width,
      child: IgnorePointer(
        child: Semantics(
          button: true,
          label: 'Note on the page: ${annotation.preview}',
          child: Container(
            padding: EdgeInsets.all(fontSize * 0.45),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(fontSize * 0.5),
              border: Border.all(
                color: color.withValues(alpha: 0.75),
                width: 1,
              ),
            ),
            child: Text(
              annotation.body.isEmpty ? 'Tap to write' : annotation.body,
              style: TextStyle(
                fontSize: fontSize,
                height: 1.3,
                color: color,
                fontWeight: FontWeight.w600,
                fontStyle: annotation.body.isEmpty
                    ? FontStyle.italic
                    : FontStyle.normal,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// How solid a note pin is drawn.
const pinOpacity = 0.8;

/// Black or white, whichever stands out on [background].
Color _readableOn(Color background) {
  return background.computeLuminance() > 0.5
      ? const Color(0xFF10161C)
      : const Color(0xFFFFFFFF);
}
