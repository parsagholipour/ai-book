/// How many of the answers a question offers the reader may actually send.
///
/// The planner and the creation interviewer both ask questions that several
/// options answer at once ("which of these themes should the tales carry?").
/// Before this existed every list was a fork, so the app sent the first tap and
/// silently dropped the rest — and the models learned to work around it by
/// listing their options inside the prompt text and asking for a typed answer.
enum QuestionAnswerKind {
  /// Exactly one option can be true. Tapping it answers the question.
  choice,

  /// Several options can be true together. The reader selects as many as they
  /// want and sends them as one answer.
  multi,

  /// The answer is a value only the reader has, so there is nothing to tap.
  open;

  bool get allowsMultiple => this == QuestionAnswerKind.multi;
}

/// Reads the wire value, with the option count as the deciding vote: fewer than
/// two options is open whatever the server said, because one option is neither a
/// choice nor a set to combine.
QuestionAnswerKind questionAnswerKindFromJson(
  Object? value, {
  required int optionCount,
}) {
  if (optionCount < 2) {
    return QuestionAnswerKind.open;
  }
  return switch (value) {
    'multi' => QuestionAnswerKind.multi,
    'open' => QuestionAnswerKind.open,
    _ => QuestionAnswerKind.choice,
  };
}

/// Joins the picks of a multi-answer question into the one line that gets sent.
///
/// That line is a real chat message: the reader sees it in the transcript and
/// the model reads it as the answer, so the separator follows the script of the
/// answers themselves — a Persian or Arabic list strung together with a Latin
/// comma reads as broken text in the language the question was asked in.
String joinQuestionAnswers(Iterable<String> answers) {
  final picked = answers
      .map((answer) => answer.trim())
      .where((answer) => answer.isNotEmpty)
      .toList();
  final separator = picked.any(_arabicScript.hasMatch) ? '، ' : ', ';
  return picked.join(separator);
}

/// Arabic, Arabic Supplement, and the presentation-form blocks — enough to
/// recognise Persian, Arabic and Urdu answers.
final _arabicScript = RegExp('[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]');
