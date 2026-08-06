import 'package:flutter/material.dart';

import '../domain/creation_models.dart';

/// Shared, user-facing labels and preset option data for the Book Studio.
///
/// Kept separate from any single screen so the conversational creation flow
/// and the advanced settings sheet share one vocabulary.

class CreationPresetOption {
  const CreationPresetOption({
    required this.value,
    required this.title,
    required this.subtitle,
    required this.icon,
  });

  final String value;
  final String title;
  final String subtitle;
  final IconData icon;
}

class CreationLanguageOption {
  const CreationLanguageOption({required this.code, required this.label});

  final String code;
  final String label;
}

const bookTypePresetOptions = <CreationPresetOption>[
  CreationPresetOption(
    value: 'auto',
    title: 'Auto',
    subtitle: 'Let the studio detect the best shape from your chat.',
    icon: Icons.auto_awesome_outlined,
  ),
  CreationPresetOption(
    value: 'practical_guide',
    title: 'Practical guide',
    subtitle: 'A useful how-to or explainer with clear next steps.',
    icon: Icons.menu_book_outlined,
  ),
  CreationPresetOption(
    value: 'lead_magnet',
    title: 'Lead magnet',
    subtitle: 'A concise reader win for an opt-in or audience offer.',
    icon: Icons.person_add_alt_1_outlined,
  ),
  CreationPresetOption(
    value: 'offer_guide',
    title: 'Offer guide',
    subtitle: 'A polished guide that explains a service or method.',
    icon: Icons.handshake_outlined,
  ),
  CreationPresetOption(
    value: 'workbook',
    title: 'Workbook',
    subtitle: 'Practice, prompts, exercises, and recap tools.',
    icon: Icons.edit_note_outlined,
  ),
  CreationPresetOption(
    value: 'client_tool',
    title: 'Client tool',
    subtitle: 'Onboarding, homework, or follow-through for clients.',
    icon: Icons.assignment_turned_in_outlined,
  ),
  CreationPresetOption(
    value: 'children_story',
    title: 'Children’s story',
    subtitle: 'A warm read-aloud story for younger readers.',
    icon: Icons.auto_stories_outlined,
  ),
  CreationPresetOption(
    value: 'adult_story',
    title: 'Short story',
    subtitle: 'A compact fiction arc with a beginning, turn, and ending.',
    icon: Icons.theater_comedy_outlined,
  ),
];

const qualityPresetOptions = <CreationPresetOption>[
  CreationPresetOption(
    value: 'fast',
    title: 'Quick draft',
    subtitle: 'Fastest path to a structure you can judge.',
    icon: Icons.flash_on_outlined,
  ),
  CreationPresetOption(
    value: 'balanced',
    title: 'Balanced',
    subtitle: 'Good default for clarity, examples, and usefulness.',
    icon: Icons.balance_outlined,
  ),
  CreationPresetOption(
    value: 'premium',
    title: 'Extra polish',
    subtitle: 'Our most advanced AI models, plus extra review and polish.',
    icon: Icons.workspace_premium_outlined,
  ),
];

/// Mirrors `LANGUAGE_NAME_CODES` on the server. The list used to hold six
/// Latin-script languages, so a language the chat detected from a non-Latin
/// prompt — Persian above all — had no entry and the settings sheet showed
/// "English" over a Persian book. Each label carries the endonym so a reader
/// recognises their own language in the list.
const creationLanguageOptions = <CreationLanguageOption>[
  CreationLanguageOption(code: 'en', label: 'English'),
  CreationLanguageOption(code: 'ar', label: 'العربية · Arabic'),
  CreationLanguageOption(code: 'zh', label: '中文 · Chinese'),
  CreationLanguageOption(code: 'da', label: 'Dansk · Danish'),
  CreationLanguageOption(code: 'nl', label: 'Nederlands · Dutch'),
  CreationLanguageOption(code: 'fa', label: 'فارسی · Persian'),
  CreationLanguageOption(code: 'fr', label: 'Français · French'),
  CreationLanguageOption(code: 'de', label: 'Deutsch · German'),
  CreationLanguageOption(code: 'el', label: 'Ελληνικά · Greek'),
  CreationLanguageOption(code: 'he', label: 'עברית · Hebrew'),
  CreationLanguageOption(code: 'hi', label: 'हिन्दी · Hindi'),
  CreationLanguageOption(code: 'it', label: 'Italiano · Italian'),
  CreationLanguageOption(code: 'ja', label: '日本語 · Japanese'),
  CreationLanguageOption(code: 'ko', label: '한국어 · Korean'),
  CreationLanguageOption(code: 'no', label: 'Norsk · Norwegian'),
  CreationLanguageOption(code: 'pl', label: 'Polski · Polish'),
  CreationLanguageOption(code: 'pt', label: 'Português · Portuguese'),
  CreationLanguageOption(code: 'ru', label: 'Русский · Russian'),
  CreationLanguageOption(code: 'es', label: 'Español · Spanish'),
  CreationLanguageOption(code: 'sv', label: 'Svenska · Swedish'),
  CreationLanguageOption(code: 'th', label: 'ไทย · Thai'),
  CreationLanguageOption(code: 'tr', label: 'Türkçe · Turkish'),
  CreationLanguageOption(code: 'uk', label: 'Українська · Ukrainian'),
  CreationLanguageOption(code: 'ur', label: 'اردو · Urdu'),
  CreationLanguageOption(code: 'vi', label: 'Tiếng Việt · Vietnamese'),
];

/// The picker's options, plus the stored language when it is not one of them.
///
/// Showing a fallback of "English" for an unrecognised code is a lie the reader
/// is one tap away from making true, so an unknown code becomes its own option
/// instead.
List<CreationLanguageOption> creationLanguageOptionsFor(String language) {
  final known = creationLanguageOptions.any((option) => option.code == language);
  if (known || language.isEmpty) {
    return creationLanguageOptions;
  }
  return [
    CreationLanguageOption(code: language, label: languageLabel(language)),
    ...creationLanguageOptions,
  ];
}

List<CreationPresetOption> lengthPresetOptions(String bookType) {
  return [
    CreationPresetOption(
      value: 'short',
      title: 'Short',
      subtitle: 'About ${pageRangeFor(bookType, 'short')} pages.',
      icon: Icons.short_text,
    ),
    CreationPresetOption(
      value: 'standard',
      title: 'Standard',
      subtitle: 'About ${pageRangeFor(bookType, 'standard')} pages.',
      icon: Icons.notes_outlined,
    ),
    CreationPresetOption(
      value: 'expanded',
      title: 'Expanded',
      subtitle: 'About ${pageRangeFor(bookType, 'expanded')} pages.',
      icon: Icons.library_books_outlined,
    ),
  ];
}

String laneTitle(String lane) {
  return switch (lane) {
    'auto' => 'Auto',
    'children_story' => 'Children’s story',
    'adult_story' => 'Short story',
    'workbook' => 'Workbook',
    'client_tool' => 'Client tool',
    'offer_guide' => 'Offer guide',
    'lead_magnet' => 'Lead magnet',
    _ => 'Practical guide',
  };
}

String audienceLabel(String lane) {
  return switch (lane) {
    'auto' => 'Audience',
    'children_story' => 'Age',
    'adult_story' => 'Reader vibe',
    'workbook' || 'client_tool' => 'Learner',
    _ => 'Ideal reader',
  };
}

String promiseLabel(String lane) {
  return switch (lane) {
    'auto' => 'Book goal',
    'children_story' => 'Theme / ending feel',
    'adult_story' => 'Conflict / ending',
    'workbook' || 'client_tool' => 'Practice outcome',
    _ => 'Reader win',
  };
}

String primaryPromise(MobileBookRecipe recipe) {
  List<String> parts;
  switch (recipe.lane) {
    case 'children_story':
      parts = [recipe.theme, recipe.ending];
    case 'adult_story':
      parts = [recipe.conflict, recipe.ending];
    case 'workbook':
    case 'client_tool':
      parts = [recipe.promise, recipe.nextStep];
    default:
      parts = [recipe.promise];
  }
  return parts.where((value) => value.trim().isNotEmpty).join(' / ');
}

String bookTypeLabel(String value) {
  return switch (value) {
    'auto' => 'Auto',
    'practical_guide' => 'Practical guide',
    'lead_magnet' => 'Lead magnet',
    'offer_guide' => 'Offer guide',
    'workbook' => 'Workbook',
    'client_tool' => 'Client tool',
    'children_story' => 'Children’s story',
    'adult_story' || 'short_story' => 'Short story',
    _ => 'Practical guide',
  };
}

String productBookTypeForChoice(String value, {String? detectedLane}) {
  final lane = value == 'auto' ? detectedLane : value;
  return switch (lane) {
    'workbook' || 'client_tool' => 'workbook',
    'adult_story' || 'children_story' || 'short_story' => 'short_story',
    _ => 'lead_magnet',
  };
}

String lengthLabel(String value) {
  return switch (value) {
    'short' => 'Short',
    'expanded' => 'Expanded',
    _ => 'Standard',
  };
}

String qualityLabel(String value) {
  return switch (value) {
    'fast' => 'Quick draft',
    'premium' => 'Extra polish',
    _ => 'Balanced',
  };
}

String pageCountLabelFor(MobileCreationPresets presets) {
  final targetPages = presets.targetPages;
  if (presets.pageCountMode == 'custom' && targetPages != null) {
    return targetPages == 1 ? '1 page' : '$targetPages pages';
  }
  return 'Auto';
}

String languageLabel(String code) {
  for (final option in creationLanguageOptions) {
    if (option.code == code) {
      return option.label;
    }
  }
  return code.toUpperCase();
}

String pageRangeFor(String bookType, String lengthPreset) {
  return switch ((bookType, lengthPreset)) {
    ('workbook', 'short') => '14-18',
    ('workbook', 'standard') => '24-32',
    ('workbook', 'expanded') => '36-44',
    ('client_tool', 'short') => '14-18',
    ('client_tool', 'standard') => '24-32',
    ('client_tool', 'expanded') => '36-44',
    ('short_story', 'short') => '6-10',
    ('short_story', 'standard') => '12-18',
    ('short_story', 'expanded') => '20-26',
    ('adult_story', 'short') => '6-10',
    ('adult_story', 'standard') => '12-18',
    ('adult_story', 'expanded') => '20-26',
    ('children_story', 'short') => '6-10',
    ('children_story', 'standard') => '12-18',
    ('children_story', 'expanded') => '20-26',
    (_, 'short') => '10-14',
    (_, 'expanded') => '20-26',
    _ => '16-20',
  };
}

int targetPageCountFor(String bookType, String lengthPreset) {
  return switch ((bookType, lengthPreset)) {
    ('workbook', 'short') => 16,
    ('workbook', 'standard') => 28,
    ('workbook', 'expanded') => 40,
    ('client_tool', 'short') => 16,
    ('client_tool', 'standard') => 28,
    ('client_tool', 'expanded') => 40,
    ('short_story', 'short') => 8,
    ('short_story', 'standard') => 16,
    ('short_story', 'expanded') => 24,
    ('adult_story', 'short') => 8,
    ('adult_story', 'standard') => 16,
    ('adult_story', 'expanded') => 24,
    ('children_story', 'short') => 8,
    ('children_story', 'standard') => 16,
    ('children_story', 'expanded') => 24,
    (_, 'short') => 12,
    (_, 'expanded') => 24,
    _ => 18,
  };
}

int visualLimitFor(String bookType) {
  return switch (bookType) {
    'workbook' || 'client_tool' => 6,
    _ => 4,
  };
}
