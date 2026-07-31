import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/reader_outline.dart';

List<ReaderOutlineEntry> destinations(List<int> pages) => [
  for (final page in pages)
    ReaderOutlineEntry(title: 'Page $page', depth: 0, pageNumber: page),
];

void main() {
  group('namedReaderOutline', () {
    test('gives recovered destinations their chapter titles', () {
      final named = namedReaderOutline(destinations([3, 5, 6]), const [
        'First Steps into the Unknown',
        'The Roots and Branches',
        'The Spirits',
      ]);

      expect(named.map((entry) => entry.title), [
        'First Steps into the Unknown',
        'The Roots and Branches',
        'The Spirits',
      ]);
      expect(named.map((entry) => entry.pageNumber), [3, 5, 6]);
    });

    test('keeps the page numbers when the two lists disagree', () {
      // A mismatch means the links and the plan are not the same sequence, so
      // pairing them would attach the wrong title to a chapter.
      final named = namedReaderOutline(destinations([3, 5, 6]), const [
        'Only One Chapter',
      ]);

      expect(named.map((entry) => entry.title), ['Page 3', 'Page 5', 'Page 6']);
    });

    test('does nothing without chapter titles', () {
      expect(namedReaderOutline(destinations([3]), const []).single.title, 'Page 3');
      expect(namedReaderOutline(const [], const ['A']), isEmpty);
    });
  });
}
