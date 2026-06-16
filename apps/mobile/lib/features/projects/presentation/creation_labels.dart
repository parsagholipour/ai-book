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
    value: 'lead_magnet',
    title: 'Lead magnet or guide',
    subtitle: 'A concise, useful reader win with a clear next step.',
    icon: Icons.person_add_alt_1_outlined,
  ),
  CreationPresetOption(
    value: 'workbook',
    title: 'Workbook',
    subtitle: 'Practice, prompts, exercises, and recap tools.',
    icon: Icons.edit_note_outlined,
  ),
  CreationPresetOption(
    value: 'short_story',
    title: 'Story',
    subtitle: 'A compact story with a beginning, turn, and ending.',
    icon: Icons.auto_stories_outlined,
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
    subtitle: 'More review for a public-facing draft.',
    icon: Icons.workspace_premium_outlined,
  ),
];

const creationLanguageOptions = <CreationLanguageOption>[
  CreationLanguageOption(code: 'en', label: 'English'),
  CreationLanguageOption(code: 'es', label: 'Spanish'),
  CreationLanguageOption(code: 'fr', label: 'French'),
  CreationLanguageOption(code: 'de', label: 'German'),
  CreationLanguageOption(code: 'pt', label: 'Portuguese'),
  CreationLanguageOption(code: 'it', label: 'Italian'),
];

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
    'children_story' => 'Age',
    'adult_story' => 'Reader vibe',
    'workbook' || 'client_tool' => 'Learner',
    _ => 'Ideal reader',
  };
}

String promiseLabel(String lane) {
  return switch (lane) {
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
    'workbook' => 'Workbook',
    'short_story' => 'Story',
    _ => 'Lead magnet or guide',
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
    ('short_story', 'short') => '6-10',
    ('short_story', 'standard') => '12-18',
    ('short_story', 'expanded') => '20-26',
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
    ('short_story', 'short') => 8,
    ('short_story', 'standard') => 16,
    ('short_story', 'expanded') => 24,
    (_, 'short') => 12,
    (_, 'expanded') => 24,
    _ => 18,
  };
}

int visualLimitFor(String bookType) {
  return switch (bookType) {
    'workbook' => 6,
    _ => 4,
  };
}
