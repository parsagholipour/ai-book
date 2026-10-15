import 'matter_changes.dart';

/// Server limits for the profile's text, mirrored from the profile route, in
/// UTF-16 code units (Dart's `String.length`, and what zod counts) — never in
/// characters, which is what a text field's own `maxLength` counts.
abstract final class AuthorProfileLimits {
  static const penName = 120;
  static const bio = 1500;
  static const website = 200;
  static const copyrightHolder = 160;
  static const imprint = 120;
}

/// Who the author is, once, for every new book — `GET /api/mobile/author-profile`.
///
/// Each new book takes a copy when it is created; changing the profile never
/// reaches a book that already exists. See `.scratch/book-matter/spec.md`.
class AuthorProfile {
  const AuthorProfile({
    this.penName,
    this.bio,
    this.website,
    this.copyrightHolder,
    this.imprint,
    this.allRightsReserved = false,
    this.includeAboutAuthor = true,
    this.setupPromptSeen = false,
    this.suggestedPenName,
  });

  final String? penName;
  final String? bio;
  final String? website;
  final String? copyrightHolder;
  final String? imprint;
  final bool allRightsReserved;
  final bool includeAboutAuthor;

  /// The book page's one-time "Put your name on it" card has been answered,
  /// by a save or a Not now.
  final bool setupPromptSeen;

  /// The account's display name. Offered as a pen name, never printed by
  /// itself and never saved unless the author picks it.
  final String? suggestedPenName;

  bool get hasPenName => (penName?.trim() ?? '').isNotEmpty;

  /// Whether the book page should ask for a name: never answered, and no
  /// pen name set some other way.
  bool get wantsSetupPrompt => !setupPromptSeen && !hasPenName;

  /// The suggestion worth offering, or null when there is none.
  String? get penNameSuggestion {
    final suggestion = suggestedPenName?.trim() ?? '';
    return suggestion.isEmpty ? null : suggestion;
  }

  factory AuthorProfile.fromJson(Map<String, dynamic> json) {
    return AuthorProfile(
      penName: json['penName'] as String?,
      bio: json['bio'] as String?,
      website: json['website'] as String?,
      copyrightHolder: json['copyrightHolder'] as String?,
      imprint: json['imprint'] as String?,
      allRightsReserved: json['allRightsReserved'] as bool? ?? false,
      includeAboutAuthor: json['includeAboutAuthor'] as bool? ?? true,
      setupPromptSeen: json['setupPromptSeen'] as bool? ?? false,
      suggestedPenName: json['suggestedPenName'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'penName': penName,
    'bio': bio,
    'website': website,
    'copyrightHolder': copyrightHolder,
    'imprint': imprint,
    'allRightsReserved': allRightsReserved,
    'includeAboutAuthor': includeAboutAuthor,
    'setupPromptSeen': setupPromptSeen,
    'suggestedPenName': suggestedPenName,
  };

  AuthorProfile copyWith({bool? setupPromptSeen}) {
    return AuthorProfile(
      penName: penName,
      bio: bio,
      website: website,
      copyrightHolder: copyrightHolder,
      imprint: imprint,
      allRightsReserved: allRightsReserved,
      includeAboutAuthor: includeAboutAuthor,
      setupPromptSeen: setupPromptSeen ?? this.setupPromptSeen,
      suggestedPenName: suggestedPenName,
    );
  }
}

/// A partial `PUT /api/mobile/author-profile` body: only the keys present are
/// sent, and a key in [clear] is sent as null, which empties that field.
class AuthorProfileUpdate {
  const AuthorProfileUpdate({
    this.penName,
    this.bio,
    this.website,
    this.copyrightHolder,
    this.imprint,
    this.allRightsReserved,
    this.includeAboutAuthor,
    this.setupPromptSeen,
    this.clear = const {},
  });

  /// Answers the setup prompt and changes nothing else.
  const AuthorProfileUpdate.promptSeen() : this(setupPromptSeen: true);

  final String? penName;
  final String? bio;
  final String? website;
  final String? copyrightHolder;
  final String? imprint;
  final bool? allRightsReserved;
  final bool? includeAboutAuthor;
  final bool? setupPromptSeen;

  /// Any of 'penName', 'bio', 'website', 'copyrightHolder', 'imprint'.
  final Set<String> clear;

  bool get isEmpty => toJson().isEmpty;

  Map<String, Object?> toJson() => {
    'penName': ?penName,
    'bio': ?bio,
    'website': ?website,
    'copyrightHolder': ?copyrightHolder,
    'imprint': ?imprint,
    'allRightsReserved': ?allRightsReserved,
    'includeAboutAuthor': ?includeAboutAuthor,
    'setupPromptSeen': ?setupPromptSeen,
    for (final field in clear) field: null,
  };
}

/// What the author changed on the profile screen, as a partial update, or
/// null when there is nothing to send.
///
/// Saving the screen also answers the book page's setup prompt, so a profile
/// that has not answered it always has something to send.
AuthorProfileUpdate? authorProfileChanges(
  AuthorProfile original, {
  required String penName,
  required String bio,
  required String website,
  required String copyrightHolder,
  required String imprint,
  required bool allRightsReserved,
  required bool includeAboutAuthor,
}) {
  final changes = MatterChanges();
  final update = AuthorProfileUpdate(
    penName: changes.text('penName', original.penName, penName),
    bio: changes.text('bio', original.bio, bio),
    website: changes.text('website', original.website, website),
    copyrightHolder: changes.text(
      'copyrightHolder',
      original.copyrightHolder,
      copyrightHolder,
    ),
    imprint: changes.text('imprint', original.imprint, imprint),
    allRightsReserved: changes.flag(
      original.allRightsReserved,
      allRightsReserved,
    ),
    includeAboutAuthor: changes.flag(
      original.includeAboutAuthor,
      includeAboutAuthor,
    ),
    setupPromptSeen: original.setupPromptSeen ? null : true,
    clear: changes.cleared,
  );
  return update.isEmpty ? null : update;
}
