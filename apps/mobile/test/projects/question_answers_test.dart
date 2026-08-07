import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/question_answers.dart';

void main() {
  group('questionAnswerKindFromJson', () {
    test('reads the shape the server declared', () {
      expect(
        questionAnswerKindFromJson('multi', optionCount: 3),
        QuestionAnswerKind.multi,
      );
      expect(
        questionAnswerKindFromJson('choice', optionCount: 2),
        QuestionAnswerKind.choice,
      );
      // Drafts and plans stored before answerKind existed still parse.
      expect(
        questionAnswerKindFromJson(null, optionCount: 2),
        QuestionAnswerKind.choice,
      );
    });

    // One option is neither a choice nor a set to combine, so the reader types.
    test('a question with fewer than two options is open however declared', () {
      expect(
        questionAnswerKindFromJson('multi', optionCount: 1),
        QuestionAnswerKind.open,
      );
      expect(
        questionAnswerKindFromJson('choice', optionCount: 0),
        QuestionAnswerKind.open,
      );
    });
  });

  group('joinQuestionAnswers', () {
    test('joins picks into one line and drops blanks', () {
      expect(
        joinQuestionAnswers(['Forgiveness', ' Justice ', '']),
        'Forgiveness, Justice',
      );
    });

    // The joined line is a real chat message in the book's language, so a
    // Persian list must not be strung together with a Latin comma.
    test('uses the comma of the answers own script', () {
      expect(
        joinQuestionAnswers(['بخشش و گذشت', 'صبر و بردباری']),
        'بخشش و گذشت، صبر و بردباری',
      );
    });

    test('a single pick is just that pick', () {
      expect(joinQuestionAnswers(['Patience']), 'Patience');
      expect(joinQuestionAnswers(const []), '');
    });
  });
}
