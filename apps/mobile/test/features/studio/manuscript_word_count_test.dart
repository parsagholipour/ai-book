import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_word_count.dart';

void main() {
  test('counts prose words and skips markup', () {
    expect(manuscriptWordCount(''), 0);
    expect(manuscriptWordCount('It was a **dark** and *stormy* night.'), 7);
    expect(manuscriptWordCount('## The Harbour\n\n- one\n- two'), 4);
    expect(manuscriptWordCount("Don't split well-known words."), 4);
  });

  test('pictures, fences and page breaks are not words', () {
    expect(
      manuscriptWordCount(
        'One two.\n\n![A long caption here](/a.jpg)\n\n```\nlet x = 1;\n```'
        '\n\n<!-- page -->\n\nThree.',
      ),
      3,
    );
  });

  test('Persian and CJK', () {
    expect(manuscriptWordCount('روزی روزگاری در شهری کوچک'), 5);
    // Two CJK characters make a word, as on the server.
    expect(manuscriptWordCount('我们今天'), 2);
  });

  test('counts are grouped for display', () {
    expect(formatStudioCount(0), '0');
    expect(formatStudioCount(1248), '1,248');
    expect(formatStudioCount(1234567), '1,234,567');
    expect(formatStudioCount(-40), '−40');
    expect(formatStudioWords(1), '1 word');
    expect(formatStudioWords(2000), '2,000 words');
  });
}
