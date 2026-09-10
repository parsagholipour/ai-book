import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/chat_markdown.dart';

void main() {
  group('parseChatMarkdown', () {
    test('a numbered list after a sentence is a list, and the sentence after '
        'it is a paragraph', () {
      final blocks = parseChatMarkdown(
        "Here's what I found:\n"
        '1. **Wars of Independence**, early 1800s\n'
        '2. Chaco War, 1932–1935\n'
        'Casualty figures are still debated.',
      );
      expect(blocks, hasLength(4));
      expect(blocks[0], isA<ChatParagraph>());
      final first = blocks[1] as ChatListItem;
      expect(first.ordered, isTrue);
      expect(first.number, 1);
      expect(first.inlines.first.text, 'Wars of Independence');
      expect(first.inlines.first.bold, isTrue);
      expect(first.inlines.last.text, ', early 1800s');
      expect((blocks[2] as ChatListItem).number, 2);
      expect(blocks[3], isA<ChatParagraph>());
    });

    test(
      'items all numbered 1. keep 1, and an indented bullet is still a list item',
      () {
        final blocks = parseChatMarkdown(
          '1. a\n1. b\n- c\n  - d\n    continued',
        );
        expect((blocks[0] as ChatListItem).number, 1);
        expect((blocks[1] as ChatListItem).number, 1);
        final c = blocks[2] as ChatListItem;
        expect(c.ordered, isFalse);
        final d = blocks[3] as ChatListItem;
        expect(d, isA<ChatListItem>());
        expect(d.ordered, isFalse);
        expect(d.inlines.single.text, 'd\ncontinued');
      },
    );

    test('paragraph newlines are hard breaks and blank lines split', () {
      final blocks = parseChatMarkdown('one\ntwo\n\nthree');
      expect(blocks, hasLength(2));
      expect((blocks[0] as ChatParagraph).inlines.single.text, 'one\ntwo');
      expect((blocks[1] as ChatParagraph).inlines.single.text, 'three');
    });

    test('headings, quotes and fenced code', () {
      final blocks = parseChatMarkdown(
        '## Verified facts\n> quoted\n```js\nconst x = 1;\n```\nafter',
      );
      expect((blocks[0] as ChatHeading).inlines.single.text, 'Verified facts');
      expect((blocks[1] as ChatQuote).inlines.single.text, 'quoted');
      expect((blocks[2] as ChatCodeBlock).code, 'const x = 1;');
      expect((blocks[3] as ChatParagraph).inlines.single.text, 'after');
    });

    test('an unclosed fence stays literal so later markup still parses', () {
      final blocks = parseChatMarkdown('```\n**x**\n1. a');
      expect(blocks, hasLength(3));
      expect(blocks[0], isA<ChatParagraph>());
      expect((blocks[0] as ChatParagraph).inlines.single.text, '```');
      expect(blocks.whereType<ChatCodeBlock>(), isEmpty);
      expect(
        (blocks[1] as ChatParagraph).inlines.where((i) => i.bold).single.text,
        'x',
      );
      expect(blocks[2], isA<ChatListItem>());
      expect((blocks[2] as ChatListItem).inlines.single.text, 'a');

      final tagged = parseChatMarkdown('```js\n**x**');
      expect((tagged[0] as ChatParagraph).inlines.single.text, '```js');
      expect(tagged.whereType<ChatCodeBlock>(), isEmpty);

      final closed = parseChatMarkdown('```\nconst x = 1;\n```\nafter');
      expect((closed[0] as ChatCodeBlock).code, 'const x = 1;');
      expect((closed[1] as ChatParagraph).inlines.single.text, 'after');
    });

    test('Persian and Arabic-Indic markers are ordered lists', () {
      final persian = parseChatMarkdown('۱. سلام\n۲. خداحافظ');
      expect(persian, hasLength(2));
      final first = persian[0] as ChatListItem;
      expect(first.ordered, isTrue);
      expect(first.number, 1);
      expect(first.marker, '۱.');
      expect(first.inlines.single.text, 'سلام');
      final second = persian[1] as ChatListItem;
      expect(second.ordered, isTrue);
      expect(second.number, 2);
      expect(second.marker, '۲.');
      expect(second.inlines.single.text, 'خداحافظ');

      final arabicIndic = parseChatMarkdown('١. واحد');
      expect(arabicIndic, hasLength(1));
      expect((arabicIndic.single as ChatListItem).ordered, isTrue);
      expect((arabicIndic.single as ChatListItem).number, 1);
      expect((arabicIndic.single as ChatListItem).marker, '١.');
      expect((arabicIndic.single as ChatListItem).inlines.single.text, 'واحد');

      final fourDigits = parseChatMarkdown('۱۹۷۹. سال');
      expect(fourDigits, hasLength(1));
      expect(fourDigits.single, isA<ChatParagraph>());
    });

    test('a rule line is a paragraph, not dropped', () {
      for (final line in ['---', '***']) {
        final blocks = parseChatMarkdown(line);
        expect(blocks, hasLength(1), reason: line);
        expect(blocks.single, isA<ChatParagraph>(), reason: line);
      }
      expect(
        (parseChatMarkdown('---').single as ChatParagraph).inlines.single.text,
        '---',
      );
      expect(chatMessagePlainText('---'), '---');
      expect(chatMessagePlainText('***'), isNot(isEmpty));
    });
  });

  group('parseChatInlines', () {
    test('bold, italic, links and citations', () {
      final inlines = parseChatInlines(
        'See **bold** and *it* and _also_ `x` [site](https://a.b/c) '
        '[source:src_a:2:93000].',
      );
      expect(inlines.where((i) => i.bold).single.text, 'bold');
      expect(inlines.where((i) => i.italic).map((i) => i.text), ['it', 'also']);
      expect(inlines.map((i) => i.text).join(), contains('`x`'));
      final link = inlines.where((i) => i.linkUrl != null).single;
      expect(link.text, 'site');
      expect(link.linkUrl, 'https://a.b/c');
      final citation = inlines.where((i) => i.citation != null).single;
      expect(citation.citation!.sourceId, 'src_a');
      expect(citation.citation!.version, 2);
      expect(citation.citation!.passage, 93000);
    });

    test('unbalanced markers, snake_case and arithmetic stay literal', () {
      final text = '**oops and file_name_here and 5 * 3 = 15 and a_b';
      expect(parseChatInlines(text).map((i) => i.text).join(), text);
      expect(parseChatInlines(text).any((i) => i.bold || i.italic), isFalse);
    });

    test('a backslash is a literal character', () {
      final inlines = parseChatInlines(r'\*not italic');
      expect(inlines.map((i) => i.text).join(), r'\*not italic');
      expect(inlines.any((i) => i.italic), isFalse);
    });
  });

  group('chatMessagePlainText', () {
    // Shared with `apps/api/src/chatMessagePlainText.test.ts`. Expected strings from Dart.
    const fixtures = <(String, String)>[
      (
        '### Verified\nThe **Paraguayan War** was *the deadliest* [see](https://example.org/x) `1864` [source:src_a:2:93000].',
        'Verified\nThe Paraguayan War was the deadliest see `1864` .',
      ),
      (
        "Here's what I found:\n1. **Chaco War**, 1932–1935\n- Bolivia vs Paraguay\n  * nested",
        "Here's what I found:\n1. Chaco War, 1932–1935\n• Bolivia vs Paraguay\n• nested",
      ),
      (
        'Peru-Bolivia, 1780-1782, file_name_here, 5 * 3 and **oops',
        'Peru-Bolivia, 1780-1782, file_name_here, 5 * 3 and **oops',
      ),
      (
        'Use this:\n```js\nconst x = 1;\n```\nDone.',
        'Use this:\nconst x = 1;\nDone.',
      ),
      ('```\n**bold**\n1. a', '```\nbold\n1. a'),
      ('---', '---'),
      (
        'Found:\n1. **Chaco War**, 1932\n- Bolivia [source:src_a:2:1]\n## Head\n`code`',
        'Found:\n1. Chaco War, 1932\n• Bolivia\nHead\n`code`',
      ),
      ('۱. سلام\n۲. خداحافظ', '۱. سلام\n۲. خداحافظ'),
    ];

    test('agrees with the server twin on the shared fixtures', () {
      for (final (input, expected) in fixtures) {
        expect(chatMessagePlainText(input), expected, reason: input);
      }
    });
  });

  group('chatRoleUsesMarkdown', () {
    test('is false for the user, true for the assistant', () {
      expect(chatRoleUsesMarkdown('user'), isFalse);
      expect(chatRoleUsesMarkdown('USER'), isFalse);
      expect(chatRoleUsesMarkdown('assistant'), isTrue);
    });
  });

  group('chatBubbleCopyText', () {
    test("a user's **note** stays marked up; an assistant one is note", () {
      expect(chatBubbleCopyText('**note**', role: 'user'), '**note**');
      expect(chatBubbleCopyText('**note**', role: 'assistant'), 'note');
    });
  });

  group('chatTextDirection', () {
    test('emoji, numbers and combining marks do not choose the direction', () {
      expect(chatTextDirection('📚 سلام'), TextDirectionHint.rtl);
      expect(chatTextDirection('۱. Hello'), TextDirectionHint.ltr);
      expect(chatTextDirection('١٢٣'), isNull);
      expect(chatTextDirection('📚 ۱۲۳ — ...'), isNull);
      expect(chatTextDirection('\u064eHello'), TextDirectionHint.ltr);
      expect(chatTextDirection('𝑨 سلام'), TextDirectionHint.ltr);
    });

    test('reads the first strong character', () {
      expect(chatTextDirection('1. سلام Hello'), TextDirectionHint.rtl);
      expect(chatTextDirection('**Hello** سلام'), TextDirectionHint.ltr);
      expect(chatTextDirection('שלום'), TextDirectionHint.rtl);
      expect(chatTextDirection('こんにちは'), TextDirectionHint.ltr);
      expect(chatTextDirection('1234 — ...'), isNull);
    });
  });
}
