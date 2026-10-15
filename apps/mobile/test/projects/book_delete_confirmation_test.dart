import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';

// Deleting a book mid-generation used to refund every credit; now the server
// keeps what was already made, and lets an ended month's credits expire. The
// dialog is the one place the reader learns that before they tap.
void main() {
  test('tells the reader a book being written keeps what was made', () {
    final message = deleteProjectConfirmationMessage(
      title: 'The Moon Rabbit',
      status: 'generating',
    );

    expect(message, contains('"The Moon Rabbit" is still being written.'));
    expect(
      message,
      contains('you pay only for the pages and pictures already made'),
    );
    expect(message, contains('the rest of the credits come back'));
    expect(
      message,
      contains("Monthly credits from a month that has already ended don't"),
    );
    expect(message, contains('This removes the book and its generated files'));
  });

  test('promises nothing about credits for a book that is finished', () {
    final message = deleteProjectConfirmationMessage(
      title: 'The Moon Rabbit',
      status: 'complete',
    );

    expect(
      message,
      'This removes "The Moon Rabbit" and its generated files from your '
      'account. Some safety, billing, and support records may be retained.',
    );
    expect(message, isNot(contains('credits')));
  });
}
