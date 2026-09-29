import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_blocks.dart';

void main() {
  group('round trip', () {
    // Every case is normalized markdown (LF, no trailing spaces, at most one
    // blank line between blocks, trimmed); serialize(parse(x)) must be x.
    const cases = <String, String>{
      'empty': '',
      'one paragraph': 'It was a dark and stormy night.',
      'paragraphs': 'First paragraph.\n\nSecond paragraph.\n\nThird.',
      'soft line breaks': 'A line\nand its continuation\n\nNext.',
      'headings and lists':
          '## A heading\n\nText under it.\n\n- one\n- two\n\n1. first\n2. second',
      'quote and scene break':
          '> A quote\n> goes on\n\n***\n\nAfter the break.',
      'image between paragraphs':
          'Before.\n\n![A lighthouse](/assets/images/p1/upload-1.jpg)\n\nAfter.',
      'image with title':
          'Before.\n\n![Cap](/assets/images/p1/a.png "The title")\n\nAfter.',
      'image first and last':
          '![Opening](/assets/images/p1/a.jpg)\n\nMiddle.\n\n![End](/assets/images/p1/b.jpg)',
      'two images in a row':
          'Text.\n\n![a](/a.jpg)\n\n![b](/b.jpg)\n\nMore text.',
      'only an image': '![](/assets/images/p1/upload-9.jpg)',
      'inline image stays text':
          'Look at this:\n![inline](/a.jpg)\nIt sits inside the paragraph.',
      'image glued above text': '![a](/a.jpg)\nCaption-ish line under it.',
      'indented image line is text': '  ![a](/a.jpg)\n\nNext.',
      'two spaces before title is text': '![a](/a.jpg  "t")',
      'image-looking line inside a fence':
          'Code:\n\n```\n\n![not a picture](/x.jpg)\n\n```\n\nAfter.',
      'separator inside a fence':
          '```md\n<!-- page -->\n```\n\nStill one page.',
      'tilde fence with image line':
          '~~~\n![x](/x.jpg)\n\n~~~\n\n![real](/r.jpg)',
      'unclosed fence swallows the rest':
          'Intro.\n\n```\ncode\n\n![x](/x.jpg)\n\n<!-- page -->',
      'fence with blank lines inside':
          'Before.\n\n```\nline one\n\n\n\nline two\n```\n\nAfter.',
      'picture book pages':
          '![p1](/1.jpg)\n\nOnce upon a time.\n\n<!-- page -->\n\n![p2](/2.jpg)\n\nThe end.',
      'empty picture page':
          'Page one.\n\n<!-- page -->\n\n<!-- page -->\n\nPage three.',
      'separator glued to text stays text': 'Text\n<!-- page -->\nMore',
      'figure block':
          'Numbers:\n\n```figure\n{"kind":"bar","title":"Farm share"}\n```\n\nAfter the chart.',
      'figure with info string': '```figure json\n{"kind":"pie"}\n```\n\nText.',
      'figure glued to text stays text':
          'Numbers:\n```figure\n{"kind":"bar"}\n```',
      'unclosed figure stays text': 'Text.\n\n```figure\n{"kind":"bar"}',
      'figures is not a figure':
          'Text.\n\n```figures\nnot a chart\n```\n\nMore.',
      'rtl persian':
          'روزی روزگاری در شهری کوچک.\n\n![فانوس دریایی](/assets/images/p1/upload-2.jpg)\n\nپایان داستان.',
      'rtl arabic with heading': '## الفصل الأول\n\nكان يا ما كان.',
      'mixed direction':
          'He said «سلام» and left.\n\n![پرتره](/p.jpg "عنوان")\n\nThen silence.',
      'indented code after image':
          '![a](/a.jpg)\n\n    indented code\n    more code',
      'html comment that is not a separator': '<!-- note -->\n\nText.',
    };

    for (final entry in cases.entries) {
      test(entry.key, () {
        final blocks = parseManuscriptBlocks(entry.value);
        expect(serializeManuscriptBlocks(blocks), entry.value);
      });
    }
  });

  test('image paragraphs become image blocks', () {
    final blocks = parseManuscriptBlocks(
      'Before.\n\n![A lighthouse](/assets/images/p1/upload-1.jpg "Night")\n\nAfter.',
    );
    expect(blocks, const [
      TextBlock('Before.'),
      ImageBlock(
        alt: 'A lighthouse',
        url: '/assets/images/p1/upload-1.jpg',
        title: 'Night',
      ),
      TextBlock('After.'),
    ]);
  });

  test('an inline image is text, not a block', () {
    final blocks = parseManuscriptBlocks('Look:\n![x](/x.jpg)\nthere.');
    expect(blocks, const [TextBlock('Look:\n![x](/x.jpg)\nthere.')]);
  });

  test('fences hide pictures and separators', () {
    final blocks = parseManuscriptBlocks(
      '```\n\n![x](/x.jpg)\n\n<!-- page -->\n\n```',
    );
    expect(blocks, hasLength(1));
    expect(blocks.single, isA<TextBlock>());
  });

  test('a figure fence is one atomic block, kept verbatim', () {
    const raw = '```figure\n{"kind":"bar","title":"Farms"}\n```';
    final blocks = parseManuscriptBlocks('Intro.\n\n$raw\n\nOutro.');
    expect(blocks, const [
      TextBlock('Intro.'),
      FigureBlock(raw),
      TextBlock('Outro.'),
    ]);
  });

  test('page breaks split a picture book into pages', () {
    final blocks = parseManuscriptBlocks(
      '![a](/a.jpg)\n\nOne.\n\n<!-- page -->\n\nTwo.\n\n<!-- page -->\n\n![c](/c.jpg)',
    );
    final pages = manuscriptPages(blocks);
    expect(pages, hasLength(3));
    expect(pages[0], const [
      ImageBlock(alt: 'a', url: '/a.jpg'),
      TextBlock('One.'),
    ]);
    expect(pages[1], const [TextBlock('Two.')]);
    expect(pages[2], const [ImageBlock(alt: 'c', url: '/c.jpg')]);
  });

  test('CRLF input parses the same as LF', () {
    final blocks = parseManuscriptBlocks('A.\r\n\r\n![x](/x.jpg)\r\n\r\nB.');
    expect(serializeManuscriptBlocks(blocks), 'A.\n\n![x](/x.jpg)\n\nB.');
  });

  test('blank text blocks are dropped between atomic blocks', () {
    expect(
      serializeManuscriptBlocks(const [
        TextBlock(''),
        ImageBlock(alt: 'a', url: '/a.jpg'),
        TextBlock('\n\n'),
        ImageBlock(alt: 'b', url: '/b.jpg'),
        TextBlock(''),
      ]),
      '![a](/a.jpg)\n\n![b](/b.jpg)',
    );
  });

  test('text blocks lose their edge blank lines but keep indentation', () {
    expect(
      serializeManuscriptBlocks(const [
        TextBlock('\n\n    code\n\n'),
        ImageBlock(alt: '', url: '/a.jpg'),
      ]),
      '    code\n\n![](/a.jpg)',
    );
  });

  test('a caption is made safe for the image line', () {
    const image = ImageBlock(alt: 'Two\nlines [and brackets]', url: '/a.jpg');
    expect(image.markdown, '![Two lines (and brackets)](/a.jpg)');
    expect(parseImageLine(image.markdown), isNotNull);
  });

  test('paragraphs split outside fences only', () {
    expect(splitManuscriptParagraphs('One.\n\n```\na\n\nb\n```\n\nTwo.'), [
      'One.',
      '```\na\n\nb\n```',
      'Two.',
    ]);
  });

  test('round trip holds for generated chapters', () {
    // Normalized pieces, joined the way an author's chapter joins them: a
    // blank line between most, a single newline between some.
    const pieces = [
      'A plain paragraph of prose.',
      'Another one,\nwith a soft break.',
      '## A heading',
      '> A quote line',
      '- a list item\n- another',
      '***',
      '![a caption](/assets/images/p1/upload-1.jpg)',
      '![](/assets/images/p1/upload-2.png "titled")',
      '<!-- page -->',
      '```\ncode\n\n![inside](/x.jpg)\n```',
      '~~~\n<!-- page -->\n~~~',
      '```figure\n{"kind":"line"}\n```',
      'متن فارسی با **تأکید** و *کج*.',
      '    indented code',
    ];
    final random = Random(20260929);
    for (var round = 0; round < 400; round++) {
      final count = 1 + random.nextInt(9);
      final buffer = StringBuffer();
      for (var i = 0; i < count; i++) {
        if (i > 0) buffer.write(random.nextInt(5) == 0 ? '\n' : '\n\n');
        buffer.write(pieces[random.nextInt(pieces.length)]);
      }
      final markdown = buffer.toString().trim();
      expect(
        serializeManuscriptBlocks(parseManuscriptBlocks(markdown)),
        markdown,
        reason: markdown,
      );
    }
  });
}
