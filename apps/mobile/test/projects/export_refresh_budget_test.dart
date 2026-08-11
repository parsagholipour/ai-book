import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/saved_export_card.dart';

/// Drives the budget the way the card does: one `shouldPoll` per status seen,
/// one `recordAttempt` per timer tick, and returns how many polls it ran before
/// giving up.
int pollsUntilExhausted(
  ExportRefreshBudget budget, {
  required bool pdfAvailable,
  required bool epubAvailable,
  int limit = 500,
}) {
  var polls = 0;
  while (polls < limit) {
    final shouldPoll = budget.shouldPoll(
      isSettled: true,
      pdfAvailable: pdfAvailable,
      epubAvailable: epubAvailable,
    );
    if (!shouldPoll) return polls;
    budget.recordAttempt();
    polls += 1;
  }
  return polls;
}

void main() {
  group('ExportRefreshBudget', () {
    test('polls while either format is missing', () {
      final budget = ExportRefreshBudget(maxAttempts: 5);

      // The ordinary case: the compile writes the PDF and the EPUB in separate
      // steps, so only one of them is missing for a while.
      expect(
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: true,
          epubAvailable: false,
        ),
        isTrue,
      );
      expect(
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: false,
          epubAvailable: true,
        ),
        isTrue,
      );
    });

    test('stops once both formats are available', () {
      final budget = ExportRefreshBudget(maxAttempts: 5);

      expect(
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: true,
          epubAvailable: true,
        ),
        isFalse,
      );
    });

    test('does not poll for a book that is still being written', () {
      final budget = ExportRefreshBudget(maxAttempts: 5);

      expect(
        budget.shouldPoll(
          isSettled: false,
          pdfAvailable: false,
          epubAvailable: false,
        ),
        isFalse,
      );
    });

    test(
      'gives up after the allowance so a missing export cannot poll forever',
      () {
        final budget = ExportRefreshBudget(maxAttempts: 5);

        expect(
          pollsUntilExhausted(budget, pdfAvailable: true, epubAvailable: false),
          5,
        );
      },
    );

    test('starts a fresh allowance once everything has landed', () {
      final budget = ExportRefreshBudget(maxAttempts: 5);
      pollsUntilExhausted(budget, pdfAvailable: false, epubAvailable: false);
      expect(budget.attempts, 5);

      // Both files arrive: the wait is over.
      expect(
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: true,
          epubAvailable: true,
        ),
        isFalse,
      );
      expect(budget.attempts, 0);

      // The next edit deletes them again, and gets the whole allowance — a
      // lifetime counter drained across ordinary edits until the card stopped
      // polling for good.
      expect(
        pollsUntilExhausted(budget, pdfAvailable: false, epubAvailable: false),
        5,
      );
    });

    test('polls again when a file that was there goes missing', () {
      // The reported case: the EPUB never compiles, so "both available" never
      // happens and the allowance is never returned that way. The user then
      // edits, which deletes the PDF too — and the card has to notice.
      final budget = ExportRefreshBudget(maxAttempts: 5);
      expect(
        pollsUntilExhausted(budget, pdfAvailable: true, epubAvailable: false),
        5,
      );

      expect(
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: false,
          epubAvailable: false,
        ),
        isTrue,
      );
      expect(budget.attempts, 0);
    });

    test('an unchanged status does not refill the allowance', () {
      // `shouldPoll` runs on every build, not only when the status changes, so
      // seeing the same values twice must not hand back a poll.
      final budget = ExportRefreshBudget(maxAttempts: 5);
      for (var i = 0; i < 3; i += 1) {
        budget.shouldPoll(
          isSettled: true,
          pdfAvailable: true,
          epubAvailable: false,
        );
        budget.recordAttempt();
      }
      expect(budget.attempts, 3);

      budget.shouldPoll(
        isSettled: true,
        pdfAvailable: true,
        epubAvailable: false,
      );
      expect(budget.attempts, 3);
      expect(
        pollsUntilExhausted(budget, pdfAvailable: true, epubAvailable: false),
        2,
      );
    });
  });
}
