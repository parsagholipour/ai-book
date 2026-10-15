import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/book_matter/domain/book_matter.dart';
import 'package:tomeza/features/book_matter/presentation/matter_form.dart';

// Matter fields are limited in UTF-16 code units, the unit the server's zod
// `.max(n)` counts — never in characters, which a text field counts.

TextEditingValue _value(String text, {TextRange composing = TextRange.empty}) =>
    TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
      composing: composing,
    );

void main() {
  group('fitUtf16Length', () {
    test('keeps text that fits, whatever it holds', () {
      expect(fitUtf16Length('🦊🦊', 4), '🦊🦊');
      expect(fitUtf16Length('', 0), '');
    });

    test('cuts between characters, never through one', () {
      // A fox is two units; one unit left is not room for it.
      expect(fitUtf16Length('a🦊', 2), 'a');
      // A family is one character of eight units, joined by ZWJs.
      expect(fitUtf16Length('ab👨‍👩‍👧', 9), 'ab');
      expect(fitUtf16Length('ab👨‍👩‍👧', 10), 'ab👨‍👩‍👧');
      // An e and its combining accent go together.
      expect(fitUtf16Length('café', 4), 'caf');
    });
  });

  group('Utf16LengthLimitingTextInputFormatter', () {
    const formatter = Utf16LengthLimitingTextInputFormatter(4);

    test('a full field ignores more typing', () {
      final full = _value('ab🦊');
      expect(formatter.formatEditUpdate(full, _value('ab🦊c')), full);
    });

    test('a paste past the limit is cut back to what fits', () {
      final result = formatter.formatEditUpdate(_value('a'), _value('a🦊🦊'));
      expect(result.text, 'a🦊');
      expect(result.selection, const TextSelection.collapsed(offset: 3));
    });

    test('an edit within the limit passes untouched', () {
      final edit = _value('🦊🦊');
      expect(formatter.formatEditUpdate(_value('🦊'), edit), edit);
    });

    test('a Japanese name can finish composing near the limit', () {
      const nameFormatter = Utf16LengthLimitingTextInputFormatter(120);
      final prefix = 'A' * 118;
      final composing = _value(
        '${prefix}nihon',
        composing: const TextRange(start: 118, end: 123),
      );
      final pending = nameFormatter.formatEditUpdate(_value(prefix), composing);
      expect(pending, composing);

      final committed = _value('$prefix日本');
      expect(nameFormatter.formatEditUpdate(pending, committed), committed);
    });

    test('a full field allows composition until it commits', () {
      final full = _value('abcd');
      final composing = _value(
        'abcde',
        composing: const TextRange(start: 4, end: 5),
      );
      final pending = formatter.formatEditUpdate(full, composing);
      expect(pending, composing);
      expect(formatter.formatEditUpdate(pending, _value('abcde')), full);
    });

    test('a commit never restores an old composing value at the limit', () {
      final composing = _value(
        'abxyz',
        composing: const TextRange(start: 2, end: 5),
      );
      final shorter = formatter.formatEditUpdate(
        composing,
        _value('abxy', composing: const TextRange(start: 2, end: 4)),
      );
      expect(
        formatter.formatEditUpdate(shorter, _value('ab日本語')),
        _value('ab日本'),
      );
    });
  });

  testWidgets('a composition-only commit applies the matter field limit', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'a');
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MatterTextField(
            fieldKey: 'name',
            controller: controller,
            label: 'Name',
            maxLength: 4,
          ),
        ),
      ),
    );
    await tester.showKeyboard(find.byKey(const ValueKey('name')));
    final composing = _value(
      'a🦊🦊',
      composing: const TextRange(start: 1, end: 5),
    );
    tester.testTextInput.updateEditingValue(composing);
    await tester.pump();
    expect(controller.value, composing);

    tester.testTextInput.updateEditingValue(_value(composing.text));
    await tester.pump();
    expect(controller.value, _value('a🦊'));
  });

  group('isbnWithoutLabel', () {
    test('takes the label off the way the server does', () {
      // The cases apps/api/src/mobile/bookMatterRoutes.test.ts stores.
      const stored = {
        'ISBN 978-0-306-40615-7': '978-0-306-40615-7',
        'isbn: 0-8044-2957-X': '0-8044-2957-X',
        'ISBN-13: 978-0-306-40615-7': '978-0-306-40615-7',
        // The server trims what is left; the label is all this takes.
        '  ISBN-13 :  978 0 306 40615 7 ': '978 0 306 40615 7 ',
        '978-0-306-40615-7': '978-0-306-40615-7',
        'ISBN hello': 'hello',
        // A 10 or 13 a digit follows is the number's, not the label's.
        'ISBN 1040123457': '1040123457',
        'ISBN 1302015435': '1302015435',
        // The label alone is kept, for the server to refuse.
        'ISBN': 'ISBN',
        'ISBN-13: ': 'ISBN-13: ',
      };
      for (final MapEntry(key: typed, value: isbn) in stored.entries) {
        expect(isbnWithoutLabel(typed), isbn, reason: typed);
      }
    });
  });

  group('IsbnTextInputFormatter', () {
    const formatter = IsbnTextInputFormatter(24);

    /// [text] typed one key at a time at the end of the field.
    TextEditingValue typed(String text) {
      var value = _value('');
      for (final key in text.split('')) {
        value = formatter.formatEditUpdate(value, _value(value.text + key));
      }
      return value;
    }

    test('a pasted label comes off, and the ISBN under it fits', () {
      final pasted = formatter.formatEditUpdate(
        _value(''),
        _value('ISBN-13: 978-0-306-40615-7'),
      );
      expect(pasted.text, '978-0-306-40615-7');
      expect(pasted.selection, const TextSelection.collapsed(offset: 17));
    });

    test('pasted native-numeral labels leave the printed ISBN intact', () {
      const numbers = {
        'ISBN-۱۳: ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷': '۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷',
        'ISBN-١٣: ٩٧٨-٠-٣٠٦-٤٠٦١٥-٧': '٩٧٨-٠-٣٠٦-٤٠٦١٥-٧',
        'ISBN-१३: ९७८-०-३०६-४०६१५-७': '९७८-०-३०६-४०६१५-७',
        'ISBN-১৩: ৯৭৮-০-৩০৬-৪০৬১৫-৭': '৯৭৮-০-৩০৬-৪০৬১৫-৭',
        'ISBN-๑๓: ๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗': '๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗',
        'ISBN-１３: ９７８-０-３０６-４０６１５-７': '９７８-０-３０６-４０６１５-７',
        'ISBN-۱۰: ۰-۸۰۴۴-۲۹۵۷-X': '۰-۸۰۴۴-۲۹۵۷-X',
        'ISBN ۱۰۴۰۱۲۳۴۵۷': 'ISBN ۱۰۴۰۱۲۳۴۵۷',
        'ISBN ۱۳۰۲۰۱۵۴۳۵': 'ISBN ۱۳۰۲۰۱۵۴۳۵',
        'ISBN 10۴۰۱۲۳۴۵۷': 'ISBN 10۴۰۱۲۳۴۵۷',
        'ISBN 13۰۲۰۱۵۴۳۵': 'ISBN 13۰۲۰۱۵۴۳۵',
      };
      for (final MapEntry(key: input, value: printed) in numbers.entries) {
        expect(
          formatter.formatEditUpdate(_value(''), _value(input)),
          _value(printed),
          reason: input,
        );
      }
      expect(typed('ISBN-۱۳: ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷').text, '۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷');
      expect(typed('ISBN ۱-۵۶۶۱۹-۹۰۹-۳').text, 'ISBN ۱-۵۶۶۱۹-۹۰۹-۳');
    });

    test('label stripping waits for active composition to commit', () {
      final composing = _value(
        'ISBN-13: 978-0-306-40615-7',
        composing: const TextRange(start: 9, end: 26),
      );
      final pending = formatter.formatEditUpdate(_value(''), composing);
      expect(pending, composing);
      expect(
        formatter.formatEditUpdate(pending, _value(composing.text)),
        _value('978-0-306-40615-7'),
      );
    });

    test('a typed label comes off once the number starts, and not before', () {
      expect(typed('ISBN-13').text, 'ISBN-13');
      expect(typed('ISBN-13: ').text, 'ISBN-13: ');
      expect(typed('ISBN-13: 978-0-306-40615-7').text, '978-0-306-40615-7');
      expect(typed('ISBN 13: 978-0-306-40615-7').text, '978-0-306-40615-7');
      expect(typed('isbn 0-8044-2957-X').text, '0-8044-2957-X');
      expect(typed('ISBN hello').text, 'ISBN hello');
    });

    test('"ISBN 1" may be "ISBN 13" on its way, so an ISBN-10 starting with 1 '
        'keeps its label, for the server to take off', () {
      expect(typed('ISBN 1').text, 'ISBN 1');
      expect(typed('ISBN 1-56619-909-3').text, 'ISBN 1-56619-909-3');
    });

    test(
      'the limit counts what the server counts: a label left on is free',
      () {
        final number = '1${'2' * 23}';
        expect(
          formatter.formatEditUpdate(_value(''), _value('ISBN $number')).text,
          'ISBN $number',
        );
        expect(
          formatter
              .formatEditUpdate(_value(''), _value('ISBN ${number}9'))
              .text,
          'ISBN $number',
        );
        expect(
          formatter.formatEditUpdate(_value(''), _value('${number}9')).text,
          number,
        );
      },
    );
  });
}
