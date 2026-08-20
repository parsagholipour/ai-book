import 'character_models.dart';

/// An @token being typed at the caret; [start] is the index of its @.
class CharacterMentionQuery {
  const CharacterMentionQuery({required this.start, required this.query});

  final int start;
  final String query;
}

/// One resolved occurrence in prose, using Dart/JSON UTF-16 offsets.
class CharacterMentionRange {
  const CharacterMentionRange({
    required this.mention,
    required this.start,
    required this.end,
  });

  final CharacterMention mention;
  final int start;
  final int end;
}

class _Candidate {
  const _Candidate({
    required this.id,
    required this.name,
    required this.token,
    required this.inserted,
  });

  final String id;
  final String name;

  /// The literal `@Name` this candidate is spelled with.
  final String token;

  /// Whether the reader picked this character off the suggestion strip.
  final bool inserted;
}

class _Claim {
  const _Claim({required this.candidate, required this.start, required this.end});

  final _Candidate candidate;
  final int start;
  final int end;
}

/// Resolves text-derived mentions in textual order.
///
/// [limit] is the caller's cap and is **not** a trim: an over-full set comes
/// back over-full (one past [limit]) so the caller can refuse it. Quietly
/// returning a legal-looking ten out of eleven is what deleted a durable link
/// whose `@Name` was still sitting in the prose, because the editor's Save
/// sends the resolved set as the authoritative one.
List<CharacterMention> resolveCharacterMentions({
  required String text,
  required Map<String, String> inserted,
  required List<LibraryCharacter> characters,
  String? excludeCharacterId,
  int limit = 10,
}) {
  final available = [
    for (final character in characters)
      if (character.id != excludeCharacterId) character,
  ];
  final ambiguous = _ambiguousNames(available);
  final candidates = <_Candidate>[
    for (final entry in inserted.entries)
      if (entry.key != excludeCharacterId)
        _Candidate(
          id: entry.key,
          name:
              _characterNamed(available, entry.key)?.name ??
              entry.value.substring(1),
          token: entry.value,
          inserted: true,
        ),
    // Two saved characters whose names differ only in case are one name to a
    // typed mention, and guessing which one the reader meant is how the wrong
    // face reaches the book. Tapping the chip still binds either.
    for (final character in available)
      if (!ambiguous.contains(character.name.toLowerCase()))
        _Candidate(
          id: character.id,
          name: character.name,
          token: '@${character.name}',
          inserted: false,
        ),
  ];

  final mentions = <CharacterMention>[];
  final seen = <String>{};
  for (final claim in _claimMentions(text, candidates)) {
    if (!seen.add(claim.candidate.id)) continue;
    mentions.add(
      CharacterMention(id: claim.candidate.id, name: claim.candidate.name),
    );
    if (mentions.length > limit) break;
  }
  return mentions;
}

/// Every occurrence of the saved links, each span claimed by one character.
///
/// The whole link set claims together — longest name first, exact spelling
/// ahead of a case-insensitive one — so "@Luna Vega" is drawn as Vega's chip
/// rather than as Luna's with " Vega" trailing out of it.
List<CharacterMentionRange> savedCharacterMentionRanges(
  String text,
  List<CharacterMention> mentions,
) {
  final byId = {for (final mention in mentions) mention.id: mention};
  final candidates = [
    for (final mention in mentions)
      _Candidate(
        id: mention.id,
        name: mention.name,
        token: '@${mention.name}',
        inserted: false,
      ),
  ];
  return [
    for (final claim in _claimMentions(text, candidates))
      if (byId[claim.candidate.id] case final mention?)
        CharacterMentionRange(
          mention: mention,
          start: claim.start,
          end: claim.end,
        ),
  ];
}

/// Whether [mentionText] (`@Name`) still occurs in [text] as a whole mention.
///
/// Case-insensitive, and a possessive is a boundary: "@Luna's hat" is a
/// mention of Luna. Reading it as one word pruned the reader's own tapped pick
/// and shipped the message with no character ids at all.
bool characterTextHasMention(String text, String mentionText) =>
    _claimMentions(text, [
      _Candidate(
        id: '',
        name: mentionText.length > 1 ? mentionText.substring(1) : '',
        token: mentionText,
        inserted: true,
      ),
    ]).isNotEmpty;

CharacterMentionQuery? characterMentionQueryAt(String text, int caret) {
  if (caret < 0 || caret > text.length) return null;
  final upToCaret = text.substring(0, caret);
  final at = upToCaret.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && _isNameCharacterAt(upToCaret, at - 1)) return null;
  final query = upToCaret.substring(at + 1);
  if (query.length > 40 || query.contains('\n') || query.contains('@')) {
    return null;
  }
  return CharacterMentionQuery(start: at, query: query);
}

Set<String> _ambiguousNames(List<LibraryCharacter> characters) {
  final seen = <String, int>{};
  for (final character in characters) {
    final name = character.name.toLowerCase();
    seen[name] = (seen[name] ?? 0) + 1;
  }
  return {
    for (final entry in seen.entries)
      if (entry.value > 1) entry.key,
  };
}

LibraryCharacter? _characterNamed(
  List<LibraryCharacter> characters,
  String id,
) {
  for (final character in characters) {
    if (character.id == id) return character;
  }
  return null;
}

/// What continues the word an `@token` sits in.
///
/// ZWNJ and ZWJ are in here because Persian sets them **inside** words:
/// «علی‌رضا» is one name joined by U+200C, and with the joiner outside this
/// class a saved «علی» ends cleanly in front of it and claims the first half of
/// somebody else's name. The apostrophes are deliberately *out*: a possessive
/// ends a token. Kept identical to `NAME_CHARACTER` in
/// `packages/core/src/generation/libraryCharacterMentions.ts`.
final _nameCharacter = RegExp(
  r'[\p{L}\p{N}\p{M}\p{Pc}\u200C\u200D]',
  unicode: true,
);

/// Hyphens that join two words into one. A hyphen in front of a word joins it
/// ("@Luna-Bear" names nobody unless "Luna-Bear" is itself saved); anywhere
/// else it is ordinary punctuation that ends the token.
final _wordJoiningHyphen = RegExp(r'[-\u2010\u2011]', unicode: true);

bool _isNameCharacterAt(String text, int index) {
  if (index < 0 || index >= text.length) return false;
  var start = index;
  final unit = text.codeUnitAt(index);
  if (unit >= 0xdc00 && unit <= 0xdfff && index > 0) {
    final previous = text.codeUnitAt(index - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
  }
  final first = text.codeUnitAt(start);
  final hasLowSurrogate =
      start + 1 < text.length &&
      text.codeUnitAt(start + 1) >= 0xdc00 &&
      text.codeUnitAt(start + 1) <= 0xdfff;
  final length = first >= 0xd800 && first <= 0xdbff && hasLowSurrogate ? 2 : 1;
  return _nameCharacter.hasMatch(text.substring(start, start + length));
}

/// Whether a complete name match ending at [end] stops there rather than
/// mid-word.
bool _endsMentionToken(String text, int end) {
  if (end >= text.length) return true;
  if (_isNameCharacterAt(text, end)) return false;
  return !(_wordJoiningHyphen.hasMatch(text[end]) &&
      _isNameCharacterAt(text, end + 1));
}

/// Which candidate owns the token opening at [at], or null when nobody does.
///
/// Longest name wins; then a pick the reader tapped beats one inferred from the
/// prose; then a name spelled exactly as the prose spells it beats one that
/// only matches case-insensitively. Two candidates left tied claim nothing — a
/// missing mention is a character drawn from prose, a wrong one is a stranger
/// wearing the reader's saved face.
_Candidate? _claimAt(String text, int at, List<_Candidate> candidates) {
  _Candidate? best;
  var bestExact = false;
  var contested = false;
  for (final candidate in candidates) {
    final end = at + candidate.token.length;
    if (end > text.length) continue;
    final spelling = text.substring(at, end);
    final exact = spelling == candidate.token;
    if (!exact && spelling.toLowerCase() != candidate.token.toLowerCase()) {
      continue;
    }
    if (!_endsMentionToken(text, end)) continue;
    if (best == null) {
      best = candidate;
      bestExact = exact;
      contested = false;
      continue;
    }
    if (best.id == candidate.id) continue;
    final longer = candidate.token.length - best.token.length;
    final sameLength = longer == 0;
    final sameSource = candidate.inserted == best.inserted;
    if (longer > 0 ||
        (sameLength && candidate.inserted && !best.inserted) ||
        (sameLength && sameSource && exact && !bestExact)) {
      best = candidate;
      bestExact = exact;
      contested = false;
    } else if (sameLength && sameSource && exact == bestExact) {
      contested = true;
    }
  }
  return contested ? null : best;
}

/// Every whole `@token` in [text], each claimed by exactly one candidate.
///
/// One left-to-right pass over the whole candidate set, so a span belongs to
/// one character and the claims come back in textual order.
List<_Claim> _claimMentions(String text, List<_Candidate> candidates) {
  final claims = <_Claim>[];
  final usable = [
    for (final candidate in candidates)
      if (candidate.token.length > 1 && candidate.name.trim().isNotEmpty)
        candidate,
  ];
  if (usable.isEmpty) return claims;

  var at = text.indexOf('@');
  while (at >= 0) {
    var resume = at + 1;
    if (!_isNameCharacterAt(text, at - 1)) {
      final owner = _claimAt(text, at, usable);
      if (owner != null) {
        final end = at + owner.token.length;
        claims.add(_Claim(candidate: owner, start: at, end: end));
        resume = end;
      }
    }
    at = text.indexOf('@', resume);
  }
  return claims;
}
