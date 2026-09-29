import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/book_blurb.dart';

import 'book_page_fixtures.dart';

// A book's description is the reader's words, never the planner's scaffolding.

void main() {
  group('cleanBriefText', () {
    test('takes the first thing the user said out of a composed prompt', () {
      expect(
        cleanBriefText(composedPrompt),
        'A lighthouse keeper finds a bottle with a letter from her future self.',
      );
    });

    test('reads a prompt whose newlines were flattened and clipped', () {
      // The preview the server sends is one clipped line, and this is the
      // shape the owner saw on the book page.
      const preview =
          'Create a short story. Book type choice: Short story Creation chat: '
          'Assistant: Hi! Tell me about the book you want to make. User: A quiet '
          'story about a lighthouse keeper. Assistant: Lovely. Aud';
      expect(
        cleanBriefText(preview),
        'A quiet story about a lighthouse keeper.',
      );
    });

    test('shows nothing when the user never spoke, never the greeting', () {
      const greetingOnly =
          'Create a short story. Book type choice: Short story Creation chat: '
          'Assistant: Hi! Tell me about the book you wa';
      expect(cleanBriefText(greetingOnly), isNull);
    });

    test('falls back to a recipe field when there is no transcript', () {
      const prompt =
          'Create a workbook.\nBook type choice: Workbook\n'
          'Original idea: A workbook for launching a course\n'
          'Audience or reader: Teachers';
      expect(cleanBriefText(prompt), 'A workbook for launching a course');
    });

    test('recognises the auto-mode instruction as scaffolding', () {
      const prompt =
          "Create the best-fitting book from the user's creation chat. Decide "
          'the real book shape during planning.\n'
          'Book type choice: Auto - decide during planning\n'
          'Creation chat: User: A picture book about a fox';
      expect(cleanBriefText(prompt), 'A picture book about a fox');
    });

    test('leaves a prompt a person typed alone', () {
      expect(
        cleanBriefText('Create a workbook for teachers launching a course.'),
        'Create a workbook for teachers launching a course.',
      );
    });

    test('cuts a long message at a word, with an ellipsis', () {
      final long = 'word ' * 60;
      final cleaned = cleanBriefText(long, maxLength: 40)!;
      expect(cleaned.length, lessThanOrEqualTo(41));
      expect(cleaned, endsWith('…'));
      expect(cleaned, isNot(contains('wor…')));
    });
  });

  group('bookBlurb', () {
    test('prefers the tagline, then the premise, then the cleaned brief', () {
      final plan = bookPlan();
      expect(
        bookBlurb(
          bookProject(subtitle: 'A keeper and a bottle', plan: plan),
          plan: plan,
        ),
        'A keeper and a bottle',
      );
      expect(
        bookBlurb(bookProject(plan: plan), plan: plan),
        'A keeper decides whether to answer a letter from tomorrow.',
      );
      expect(
        bookBlurb(bookProject(withPlan: false)),
        'A lighthouse keeper finds a bottle with a letter from her future self.',
      );
    });

    test('can leave the premise to a plan that is on screen in full', () {
      final plan = bookPlan();
      expect(
        bookBlurb(bookProject(plan: plan), plan: plan, usePremise: false),
        startsWith('A lighthouse keeper finds'),
      );
    });
  });
}
