import '../../projects/domain/creation_models.dart';

/// "Make a book like this": a shared book's *format*, fetched by the slug on
/// its public page, for a new creation chat to start from.
///
/// Format only, by construction on the server — the type, length, effort,
/// picture switches and page count. The shared book's brief, plan, cast and
/// text never reach the app, so none of them can reach the new book.
class BookRemix {
  const BookRemix({
    required this.slug,
    required this.title,
    required this.presets,
  });

  /// The share the chat was started from. The request that starts the chat
  /// session carries it, so the draft records where it came from.
  final String slug;

  /// The shared book's title, for the composer's opening line.
  final String title;

  /// The format as the server sent it; see [chatPresets] for what the chat
  /// applies.
  final MobileCreationPresets presets;

  factory BookRemix.fromJson(String slug, Map<String, dynamic> json) {
    return BookRemix(
      slug: slug,
      title: (json['title'] as String? ?? '').trim(),
      presets: MobileCreationPresets.fromJson(
        json['presets'] as Map<String, dynamic>,
      ),
    );
  }

  /// The book-type *choice* the chat should hold.
  ///
  /// The chat derives the product type it sends from the choice on every
  /// request, so a choice of `auto` — which the server echoes when the shared
  /// book's type was detected rather than picked — would let a short story's
  /// remix go out as a guide. An `auto` or missing choice is therefore pinned
  /// to a concrete one of the same product type: the product types are exactly
  /// what the three branches below produce.
  String get bookTypeChoice => concreteBookTypeChoice(presets);

  /// [presets] as the chat applies them: the concrete choice, the rest as sent.
  MobileCreationPresets get chatPresets =>
      presets.copyWith(bookTypeChoice: bookTypeChoice);
}

/// A format's book-type choice pinned to a concrete one — see
/// [BookRemix.bookTypeChoice]. Shared with "Write the next book", which starts
/// a chat from a book's format the same way a remix does.
String concreteBookTypeChoice(MobileCreationPresets presets) {
  final choice = presets.bookTypeChoice.trim();
  if (choice.isNotEmpty && choice != 'auto') {
    return choice;
  }
  return switch (presets.bookType) {
    'workbook' => 'workbook',
    'short_story' => 'adult_story',
    _ => 'practical_guide',
  };
}
