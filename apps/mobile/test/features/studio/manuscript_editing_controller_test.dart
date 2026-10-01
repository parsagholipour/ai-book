import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/presentation/manuscript_editing_controller.dart';

final _scheme = buildTomezaLightTheme().colorScheme;
final _palette = ManuscriptSpanPalette(
  base: const TextStyle(fontSize: 18, color: Colors.black),
  scheme: _scheme,
);

List<TextSpan> _spans(
  ManuscriptEditingController controller, {
  TextRange? composing,
}) {
  final root = controller.buildStyledSpan(
    palette: _palette,
    composing: composing ?? TextRange.empty,
  );
  return root.children!.cast<TextSpan>();
}

/// The style of the span that carries [fragment] (the first one).
TextStyle _styleOf(List<TextSpan> spans, String fragment) {
  for (final span in spans) {
    if (span.text == fragment) return span.style!;
  }
  for (final span in spans) {
    if ((span.text ?? '').contains(fragment)) return span.style!;
  }
  throw TestFailure('No span holds "$fragment": ${spans.map((s) => s.text)}');
}

void main() {
  test('styling never changes the text', () {
    const text =
        '# Title\n\nSome **bold**, *italic* and `code`.\n\n> A quote\n\n- item'
        '\n\n***\n\n```\n**not bold**\n```\n\n![pic](/a.jpg)';
    final controller = ManuscriptEditingController(text: text);
    final spans = _spans(controller);
    expect(spans.map((span) => span.text).join(), text);
  });

  test('headings are larger and bold; their marks are faint', () {
    final spans = _spans(ManuscriptEditingController(text: '## The Harbour'));
    final heading = _styleOf(spans, 'The Harbour');
    expect(heading.fontSize, greaterThan(18));
    expect(heading.fontWeight, FontWeight.w800);
    final marker = _styleOf(spans, '## ');
    expect(marker.fontSize, lessThan(18));
    expect(marker.color!.a, lessThan(0.5));
    // A level-1 heading is larger than a level-3 one.
    final h1 = _styleOf(_spans(ManuscriptEditingController(text: '# A')), 'A');
    final h3 = _styleOf(
      _spans(ManuscriptEditingController(text: '### A')),
      'A',
    );
    expect(h1.fontSize, greaterThan(h3.fontSize!));
  });

  test('bold, italic, strikethrough and code', () {
    final spans = _spans(
      ManuscriptEditingController(
        text: 'a **strong** b *soft* c _also_ d ~~gone~~ e `mono` f',
      ),
    );
    expect(_styleOf(spans, 'strong').fontWeight, FontWeight.w800);
    expect(_styleOf(spans, 'soft').fontStyle, FontStyle.italic);
    expect(_styleOf(spans, 'also').fontStyle, FontStyle.italic);
    expect(_styleOf(spans, 'gone').decoration, TextDecoration.lineThrough);
    expect(_styleOf(spans, 'mono').fontFamily, 'monospace');
  });

  test('bold and italic nest, and snake_case stays plain', () {
    final spans = _spans(
      ManuscriptEditingController(text: '***both*** and file_name_here'),
    );
    final both = _styleOf(spans, 'both');
    expect(both.fontWeight, FontWeight.w800);
    expect(both.fontStyle, FontStyle.italic);
    expect(
      _styleOf(spans, 'file_name_here').fontStyle,
      isNot(FontStyle.italic),
    );
  });

  test('unbalanced markers stay literal', () {
    final spans = _spans(
      ManuscriptEditingController(text: 'a **open and * lone'),
    );
    expect(spans.map((s) => s.text).join(), 'a **open and * lone');
    expect(spans.every((s) => s.style!.fontWeight != FontWeight.w800), isTrue);
  });

  test('quotes are italic and muted; list markers take the brand tint', () {
    final spans = _spans(
      ManuscriptEditingController(
        text: '> Said softly\n\n- first\n12. twelfth',
      ),
    );
    final quote = _styleOf(spans, 'Said softly');
    expect(quote.fontStyle, FontStyle.italic);
    expect(quote.color, _scheme.onSurfaceVariant);
    expect(_styleOf(spans, '-').color, _scheme.primary);
    expect(_styleOf(spans, '12.').color, _scheme.primary);
  });

  test('a scene break is muted and spaced', () {
    final spans = _spans(
      ManuscriptEditingController(text: 'End.\n\n***\n\nNext.'),
    );
    final rule = _styleOf(spans, '***');
    expect(rule.letterSpacing, greaterThan(4));
    expect(rule.color, isNot(Colors.black));
  });

  test('nothing inside a code fence is styled as markdown', () {
    final spans = _spans(
      ManuscriptEditingController(text: '```\n**not bold**\n```\n\n**bold**'),
    );
    expect(_styleOf(spans, '**not bold**').fontFamily, 'monospace');
    expect(_styleOf(spans, 'bold').fontWeight, FontWeight.w800);
  });

  test('a blank line is drawn at half height', () {
    final spans = _spans(ManuscriptEditingController(text: 'One.\n\nTwo.'));
    final newlines = spans.where((span) => span.text == '\n').toList();
    expect(newlines, hasLength(2));
    // The first ends "One."; the second is the blank line itself.
    double lineHeight(TextStyle s) => s.fontSize! * (s.height ?? 1);
    expect(lineHeight(newlines[0].style!), closeTo(18, 0.001));
    expect(lineHeight(newlines[1].style!), lessThan(18 * 0.9));
    // Short by negative even leading, which keeps the baseline low in the
    // line: the field puts the caret by it. See ManuscriptCaret.
    expect(
      newlines[1].style!.leadingDistribution,
      TextLeadingDistribution.even,
    );
  });

  test('the marks of bold and italic are in the text and not drawn', () {
    const text = 'a **strong** b *soft* c __also__ d _too_ e';
    final spans = _spans(ManuscriptEditingController(text: text));
    expect(spans.map((span) => span.text).join(), text);
    final hidden = [
      for (final span in spans)
        if (span.style!.fontSize == 0) span.text,
    ];
    expect(hidden, ['**', '**', '*', '*', '__', '__', '_', '_']);
    // Every character that is not a mark is drawn at its own size.
    for (final span in spans) {
      if (span.style!.fontSize == 0) continue;
      expect(span.style!.fontSize, greaterThan(0), reason: '"${span.text}"');
    }
    expect(_styleOf(spans, 'strong').fontWeight, FontWeight.w800);
    expect(_styleOf(spans, 'soft').fontStyle, FontStyle.italic);
  });

  test('a mark with nothing to close stays visible', () {
    final spans = _spans(
      ManuscriptEditingController(text: 'a **open and * lone and file_name'),
    );
    expect(spans.where((span) => span.style!.fontSize == 0), isEmpty);
  });

  test('other marks stay faint: strikethrough, code, links, headings', () {
    final spans = _spans(
      ManuscriptEditingController(
        text: '## Title\n\n~~gone~~ `mono` [link](https://a.b)',
      ),
    );
    for (final mark in ['## ', '~~', '`', '[', '](https://a.b)']) {
      final style = _styleOf(spans, mark);
      expect(style.fontSize, greaterThan(0), reason: mark);
      expect(style.color!.a, lessThan(0.5), reason: mark);
    }
  });

  test('marks inside a heading or a quote are hidden too', () {
    final spans = _spans(
      ManuscriptEditingController(text: '## A **big** day\n\n> *softly* said'),
    );
    expect(
      [
        for (final span in spans)
          if (span.style!.fontSize == 0) span.text,
      ],
      ['**', '**', '*', '*'],
    );
    expect(_styleOf(spans, 'big').fontSize, greaterThan(18));
  });

  test('the composing region is underlined without moving text', () {
    final controller = ManuscriptEditingController(text: 'Hello **world**');
    final spans = _spans(
      controller,
      composing: const TextRange(start: 3, end: 10),
    );
    expect(spans.map((s) => s.text).join(), 'Hello **world**');
    var offset = 0;
    for (final span in spans) {
      final text = span.text!;
      final underlined =
          span.style!.decoration?.contains(TextDecoration.underline) ?? false;
      final inside = offset >= 3 && offset + text.length <= 10;
      if (text.isNotEmpty) expect(underlined, inside, reason: '"$text"');
      offset += text.length;
    }
  });

  test('lines are styled once and reused until they change', () {
    final paragraphs = List.generate(
      400,
      (i) => 'Paragraph $i has **bold** and *italic* words in it.',
    );
    final controller = ManuscriptEditingController(
      text: paragraphs.join('\n\n'),
    );
    _spans(controller);
    final first = controller.debugStyledLines;
    // One distinct blank line plus 400 paragraphs.
    expect(first, 401);

    _spans(controller);
    expect(controller.debugStyledLines, first, reason: 'nothing changed');

    controller.text = controller.text.replaceFirst(
      'Paragraph 7 ',
      'Paragraph 7, edited, ',
    );
    _spans(controller);
    expect(controller.debugStyledLines, first + 1, reason: 'one line changed');
  });

  test('a 10,000-word chapter restyles quickly after one keystroke', () {
    final words = List.generate(10000, (i) => i % 17 == 0 ? '**w$i**' : 'w$i');
    final lines = <String>[];
    for (var i = 0; i < words.length; i += 80) {
      lines.add(words.sublist(i, (i + 80).clamp(0, words.length)).join(' '));
    }
    final controller = ManuscriptEditingController(text: lines.join('\n\n'));
    _spans(controller);
    controller.text = '${controller.text} more';
    final watch = Stopwatch()..start();
    _spans(controller);
    watch.stop();
    expect(watch.elapsedMilliseconds, lessThan(50));
  });
}
