import 'project_models.dart';

// What a book says about itself, in words a reader would use.
//
// `MobileProjectDetail.prompt` is not the reader's text. For a book made in the
// creation chat it is the planner's instruction — "Create a short story. Book
// type choice: Short story. Creation chat: Assistant: Hi! …" — assembled from
// the recipe and the transcript on the server (`composeMobileProjectPrompt`).
// Drawing it as a description put the scaffolding, and the assistant's greeting,
// on the front of every book.

/// Labels the server puts in front of the lines of a composed prompt, plus the
/// sentence it opens with in auto mode. One of them is enough to know the text
/// was composed rather than typed; "Create a …" alone is not, because a person
/// can type that too.
final RegExp _composedMarker = RegExp(
  r'Book type choice:|Creation chat:|Web research gathered in chat:|'
  r'^\s*Create the best-fitting book from the user',
  caseSensitive: false,
  multiLine: true,
);

/// The recipe fields a composed prompt names, most descriptive first. Used only
/// when the transcript has no line the user wrote.
const List<String> _recipeLabels = [
  'Original idea',
  'Promise or story shape',
  'Artifact',
  'Audience or reader',
];

/// Every label a composed prompt can carry, so a value is cut where the next
/// label starts even when the newlines were flattened to spaces (the preview
/// the server sends is one line).
const List<String> _knownLabels = [
  'Book type choice',
  'Creation chat',
  'Web research gathered in chat',
  'Original idea',
  'Artifact',
  'Audience or reader',
  'Promise or story shape',
  'Tone or vibe',
  'Main character',
  'Characters from the user\'s library',
  'Conflict',
  'Theme',
  'Ending feel',
  'Next step',
  'Exercises',
  'Must include',
  'Recommended shape',
  'Planning instruction',
];

final RegExp _labelBoundary = RegExp(
  '(?:${_knownLabels.map(RegExp.escape).join('|')}):',
);

/// A speaker tag in the transcript, with the optional reply annotation the
/// server adds — `User (replying to …):`.
final RegExp _speaker = RegExp(
  r'(?:^|\n|\s)(User|Assistant)(?: \([^)\n]*\))?:\s*',
);

/// Whether [raw] is a prompt the server composed, not one a person typed.
bool looksLikeComposedBrief(String raw) => _composedMarker.hasMatch(raw);

/// The reader's own words out of [raw], or null when there are none to show.
///
/// A prompt someone typed (the import flow, an older client) is returned as it
/// is, whitespace tidied. A composed one gives up the first thing the *user*
/// said in the chat, else a recipe field; never a label, never the assistant.
/// Null means "say nothing", which is always better than the scaffolding.
String? cleanBriefText(String raw, {int maxLength = 160}) {
  final text = raw.replaceAll('\r\n', '\n').trim();
  if (text.isEmpty) {
    return null;
  }
  if (!looksLikeComposedBrief(text)) {
    return _tidy(text, maxLength);
  }
  final userLine = _firstUserLine(text);
  if (userLine != null) {
    return _tidy(userLine, maxLength);
  }
  for (final label in _recipeLabels) {
    final value = _fieldValue(text, label);
    if (value != null) {
      return _tidy(value, maxLength);
    }
  }
  return null;
}

/// The one description a book's page shows.
///
/// A plan's subtitle is the book's own tagline, so it leads; the premise is the
/// next best thing and only once there is a plan to take it from; the cleaned
/// brief is what a book has before either exists. [usePremise] is false while
/// the plan is on screen in full, where repeating its premise would be the
/// same paragraph twice.
String? bookBlurb(
  MobileProjectSummary project, {
  MobilePlan? plan,
  bool usePremise = true,
  int maxLength = 160,
}) {
  final tagline = _nonEmpty(project.subtitle) ?? _nonEmpty(plan?.subtitle);
  if (tagline != null) {
    return _tidy(tagline, maxLength);
  }
  // A book written in the Studio has no brief and no premise of its own: the
  // prompt and the plan are the app's scaffolding ("Author-written manuscript:
  // …"), never the author's words. Its subtitle is the only blurb it has.
  if (project.isWritten) {
    return null;
  }
  final premise = usePremise ? _nonEmpty(plan?.premise) : null;
  if (premise != null) {
    return _tidy(premise, maxLength);
  }
  final brief = project is MobileProjectDetail
      ? project.prompt
      : project.promptPreview;
  return cleanBriefText(brief, maxLength: maxLength);
}

String? _nonEmpty(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

/// The first thing the user wrote after the transcript label.
String? _firstUserLine(String text) {
  final chat = text.indexOf(RegExp('Creation chat:', caseSensitive: false));
  if (chat < 0) {
    return null;
  }
  final transcript = text.substring(chat);
  for (final match in _speaker.allMatches(transcript)) {
    if (match.group(1) != 'User') {
      continue;
    }
    final rest = transcript.substring(match.end);
    // The message runs to the next speaker or the next label, whichever is
    // first; a multi-line message keeps its lines.
    var end = rest.length;
    final nextSpeaker = _speaker.firstMatch(rest);
    if (nextSpeaker != null) {
      end = nextSpeaker.start;
    }
    final nextLabel = _labelBoundary.firstMatch(rest);
    if (nextLabel != null && nextLabel.start < end) {
      end = nextLabel.start;
    }
    final message = rest.substring(0, end).trim();
    if (message.isNotEmpty) {
      return message;
    }
  }
  return null;
}

String? _fieldValue(String text, String label) {
  final match = RegExp(
    '${RegExp.escape(label)}:\\s*',
    caseSensitive: false,
  ).firstMatch(text);
  if (match == null) {
    return null;
  }
  final rest = text.substring(match.end);
  var end = rest.indexOf('\n');
  if (end < 0) {
    end = rest.length;
  }
  final nextLabel = _labelBoundary.firstMatch(rest);
  if (nextLabel != null && nextLabel.start < end) {
    end = nextLabel.start;
  }
  final value = rest.substring(0, end).trim();
  return value.isEmpty ? null : value;
}

/// One paragraph, cut at a word rather than in the middle of one.
String _tidy(String text, int maxLength) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  final cut = flat.substring(0, maxLength);
  final space = cut.lastIndexOf(' ');
  final head = space > maxLength ~/ 2 ? cut.substring(0, space) : cut;
  return '${head.replaceFirst(RegExp(r'[\s,;:.\-]+$'), '')}…';
}
