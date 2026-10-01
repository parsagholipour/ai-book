/// The ideas the plan review offers for a revision.
library;

import 'project_models.dart';

/// Things people commonly ask a plan for. They fill the box rather than send:
/// a blank field is the one place a reader stalls, and a suggestion they can
/// edit is a better start than nothing.
///
/// This is the list for a non-fiction book; [planRevisionSuggestionsFor]
/// picks the one that fits the book, so a bedtime story is not offered
/// "Add more examples".
const planRevisionSuggestions = <String>[
  'Make it shorter',
  'Add more examples',
  'Use simpler language',
  'Change the chapters',
];

const _childrenStorySuggestions = <String>[
  'Make it shorter',
  'Make it gentler',
  'Add a funny moment',
  'Use simpler words',
];

const _storySuggestions = <String>[
  'Make it shorter',
  'Raise the stakes',
  'Change the ending',
  'Add more dialogue',
];

const _workbookSuggestions = <String>[
  'Make it shorter',
  'Add more exercises',
  'Use simpler language',
  'Change the chapters',
];

final _childAudience = RegExp(
  r'\b(child|children|kids?|toddlers?|preschool\w*|bedtime|picture book|read[- ]aloud|\d{1,2}[- ]?(year|yr)[- ]?olds?|ages? \d)',
  caseSensitive: false,
);
final _storyCue = RegExp(
  r'\b(story|stories|tale|fable|novel(la)?|adventure|journey|bedtime)\b|(?<!non[- ])\bfiction\b',
  caseSensitive: false,
);

/// The suggestions that fit this book: deterministic, from its product type
/// and the plan's own audience and premise. An Auto book has no type, so the
/// server's [bookShape] decides — it is read from the category generation
/// used, so it holds in any language — and only a book filed as nothing in
/// particular falls back to the plan's English words.
List<String> planRevisionSuggestionsFor({
  required String bookType,
  required MobilePlan plan,
  String bookShape = 'book',
}) {
  if (bookType == 'workbook') return _workbookSuggestions;
  if (bookType == 'lead_magnet') return planRevisionSuggestions;
  if (bookType == 'custom') {
    switch (bookShape) {
      case 'children_story':
        return _childrenStorySuggestions;
      case 'story':
        return _childAudience.hasMatch('${plan.audience} ${plan.premise}')
            ? _childrenStorySuggestions
            : _storySuggestions;
      case 'workbook':
        return _workbookSuggestions;
      case 'guide':
        return planRevisionSuggestions;
    }
  }
  // The subtitle is often the shape itself ("A short story"), and an adult
  // story's audience says "literary fiction" rather than "story".
  final words =
      '${plan.title} ${plan.subtitle ?? ''} ${plan.premise} ${plan.audience}';
  final story = bookType == 'short_story' || _storyCue.hasMatch(words);
  if (!story) return planRevisionSuggestions;
  return _childAudience.hasMatch('${plan.audience} ${plan.premise}')
      ? _childrenStorySuggestions
      : _storySuggestions;
}
