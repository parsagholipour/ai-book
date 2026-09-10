export 'chat_text_direction.dart';

/// Light markdown for chat bubbles.
///
/// Prompt subset versus parser subset: projects `CLAUDE.md` ("Chat bubbles
/// are light markdown"). Two chat-shaped deviations from CommonMark are
/// intentional:
///
/// - A newline inside a paragraph is a hard line break. The deterministic
///   server messages and the models both use newlines to mean "new line",
///   and rendering them as spaces would glue sentences together.
/// - A non-indented line after a list item starts a new paragraph rather than
///   lazily continuing the item. "9. Falklands War\nCasualty figures are..."
///   is a list followed by a sentence, not a two-line ninth item.
///
/// Everything the parser does not recognise is kept as literal text, so an
/// unbalanced `**` or a stray `_` in a title is shown rather than eaten.
sealed class ChatBlock {
  const ChatBlock();

  /// Inlines this block contributes; a code fence has none.
  List<ChatInline> get inlines;

  /// One clipboard/preview line for this block. Lists keep a marker;
  /// a code fence is the code body.
  String get plainTextLine {
    switch (this) {
      case ChatParagraph():
      case ChatHeading():
      case ChatQuote():
        return _inlineText(inlines);
      case ChatListItem(:final ordered, :final marker):
        final label = ordered ? marker : '•';
        return '$label ${_inlineText(inlines)}';
      case ChatCodeBlock(:final code):
        return code;
    }
  }
}

class ChatParagraph extends ChatBlock {
  const ChatParagraph(this.inlines);
  @override
  final List<ChatInline> inlines;
}

class ChatHeading extends ChatBlock {
  const ChatHeading(this.inlines);
  @override
  final List<ChatInline> inlines;
}

class ChatQuote extends ChatBlock {
  const ChatQuote(this.inlines);
  @override
  final List<ChatInline> inlines;
}

class ChatCodeBlock extends ChatBlock {
  const ChatCodeBlock(this.code);
  final String code;

  @override
  List<ChatInline> get inlines => const [];
}

class ChatListItem extends ChatBlock {
  const ChatListItem({
    required this.ordered,
    required this.number,
    required this.marker,
    required this.inlines,
  });

  final bool ordered;

  /// The printed number for an ordered item; ignored for bullets.
  final int number;

  /// The source marker, including its delimiter (`1.`, `۱.`, `1)`, `-`).
  final String marker;
  @override
  final List<ChatInline> inlines;
}

/// A run of text with one style, or a citation / link the renderer makes
/// tappable.
class ChatInline {
  const ChatInline(
    this.text, {
    this.bold = false,
    this.italic = false,
    this.linkUrl,
    this.citation,
  });

  final String text;
  final bool bold;
  final bool italic;

  /// An `http(s)` URL the text links to. Other schemes are left as text.
  final String? linkUrl;

  /// A server-issued citation token; the text is empty for these.
  final ChatCitation? citation;
}

/// Citation tokens are issued and validated by the server's evidence ledger.
class ChatCitation {
  const ChatCitation({
    required this.sourceId,
    required this.version,
    required this.passage,
  });

  final String sourceId;
  final int version;
  final int passage;
}

final _chatCitationPattern = RegExp(r'\[source:([a-zA-Z0-9_-]+):(\d+):(\d+)\]');

final _fencePattern = RegExp(r'^(`{3,}|~{3,})');
final _headingPattern = RegExp(r'^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$');
final _quotePattern = RegExp(r'^\s{0,3}>\s?(.*)$');
final _listPattern = RegExp(
  r'^(\s*)([-*+•]|['
  '\u0030-\u0039\u0660-\u0669\u06F0-\u06F9'
  r']{1,3}[.)])\s+(.*)$',
);
final _leadingSpacePattern = RegExp(r'^\s*');
final _linkPattern = RegExp(r'\[([^\]\n]+)\]\((https?://[^\s)]+)\)');

/// ASCII, Arabic-Indic, or Persian digit → 0–9.
int? _digitValue(int code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x0660 && code <= 0x0669) return code - 0x0660;
  if (code >= 0x06F0 && code <= 0x06F9) return code - 0x06F0;
  return null;
}

int _foldMarkerNumber(String marker) {
  var value = 0;
  for (var i = 0; i < marker.length - 1; i++) {
    value = value * 10 + _digitValue(marker.codeUnitAt(i))!;
  }
  return value;
}

List<ChatBlock> parseChatMarkdown(String text) {
  final lines = text.replaceAll('\r\n', '\n').split('\n');
  final blocks = <ChatBlock>[];
  final paragraph = <String>[];
  final quote = <String>[];

  void flushParagraph() {
    if (paragraph.isEmpty) return;
    blocks.add(ChatParagraph(parseChatInlines(paragraph.join('\n'))));
    paragraph.clear();
  }

  void flushQuote() {
    if (quote.isEmpty) return;
    blocks.add(ChatQuote(parseChatInlines(quote.join('\n'))));
    quote.clear();
  }

  void flushAll() {
    flushParagraph();
    flushQuote();
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    final trimmed = line.trim();
    if (trimmed.isEmpty) {
      flushAll();
      i += 1;
      continue;
    }
    if (_fencePattern.hasMatch(trimmed)) {
      flushAll();
      var closer = i + 1;
      while (closer < lines.length &&
          !_fencePattern.hasMatch(lines[closer].trim())) {
        closer += 1;
      }
      if (closer < lines.length) {
        blocks.add(ChatCodeBlock(lines.sublist(i + 1, closer).join('\n')));
        i = closer + 1;
        continue;
      }
      // An opener with no closer is unrecognised markup, not a code block.
      blocks.add(ChatParagraph(parseChatInlines(trimmed)));
      i += 1;
      continue;
    }
    final heading = _headingPattern.firstMatch(line);
    if (heading != null) {
      flushAll();
      blocks.add(ChatHeading(parseChatInlines(heading[1]!.trim())));
      i += 1;
      continue;
    }
    final quoted = _quotePattern.firstMatch(line);
    if (quoted != null) {
      flushParagraph();
      quote.add(quoted[1]!.trimRight());
      i += 1;
      continue;
    }
    final item = _listPattern.firstMatch(line);
    if (item != null) {
      flushAll();
      final indent = item[1]!.length;
      final marker = item[2]!;
      final ordered = _digitValue(marker.codeUnitAt(0)) != null;
      final body = StringBuffer(item[3]!.trimRight());
      i += 1;
      // Indented lines under an item continue it; anything else starts a new
      // block (see the class comment for why a flush-left line does).
      while (i < lines.length) {
        final next = lines[i];
        if (next.trim().isEmpty || _listPattern.hasMatch(next)) break;
        final nextIndent = _leadingSpacePattern.firstMatch(next)!.end;
        if (nextIndent <= indent) break;
        body.write('\n${next.trim()}');
        i += 1;
      }
      blocks.add(
        ChatListItem(
          ordered: ordered,
          number: ordered ? _foldMarkerNumber(marker) : 0,
          marker: marker,
          inlines: parseChatInlines(body.toString()),
        ),
      );
      continue;
    }
    flushQuote();
    paragraph.add(trimmed);
    i += 1;
  }
  flushAll();
  return blocks;
}

List<ChatInline> parseChatInlines(String text) => _InlineParser(text).parse();

class _InlineParser {
  _InlineParser(this.text);

  final String text;
  final List<ChatInline> out = [];
  final StringBuffer buffer = StringBuffer();
  int pos = 0;
  bool bold = false;
  bool italic = false;
  int boldCloseAt = -1;
  int italicCloseAt = -1;

  void flushText() {
    if (buffer.isEmpty) return;
    out.add(ChatInline(buffer.toString(), bold: bold, italic: italic));
    buffer.clear();
  }

  List<ChatInline> parse() {
    while (pos < text.length) {
      if (pos == boldCloseAt) {
        flushText();
        bold = false;
        boldCloseAt = -1;
        pos += 2;
        continue;
      }
      if (pos == italicCloseAt) {
        flushText();
        italic = false;
        italicCloseAt = -1;
        pos += 1;
        continue;
      }
      final ch = text[pos];
      if (ch == '[' && _tryBracket()) continue;
      if (!bold && text.startsWith('**', pos) && _tryBold()) continue;
      if (!italic && (ch == '*' || ch == '_') && _tryItalic(ch)) continue;
      buffer.write(ch);
      pos += 1;
    }
    flushText();
    return out;
  }

  bool _tryBracket() {
    final citation = _chatCitationPattern.matchAsPrefix(text, pos);
    if (citation != null) {
      flushText();
      out.add(
        ChatInline(
          '',
          citation: ChatCitation(
            sourceId: citation[1]!,
            version: int.parse(citation[2]!),
            passage: int.parse(citation[3]!),
          ),
        ),
      );
      pos = citation.end;
      return true;
    }
    final link = _linkPattern.matchAsPrefix(text, pos);
    if (link == null) return false;
    flushText();
    out.add(ChatInline(link[1]!, bold: bold, italic: italic, linkUrl: link[2]));
    pos = link.end;
    return true;
  }

  bool _tryBold() {
    final close = _closingIndex('**', pos + 2);
    if (close == -1) return false;
    flushText();
    bold = true;
    boldCloseAt = close;
    pos += 2;
    return true;
  }

  bool _tryItalic(String marker) {
    if (pos + 1 >= text.length || _isSpace(text[pos + 1])) return false;
    // A single `*` that is the second half of `**` belongs to that pair.
    if (marker == '*' && pos > 0 && text[pos - 1] == '*') return false;
    // `_` only opens at a word boundary, so snake_case stays literal.
    if (marker == '_' && pos > 0 && _isWordChar(text[pos - 1])) return false;
    final close = _closingIndex(marker, pos + 1, wordBoundary: marker == '_');
    if (close == -1) return false;
    flushText();
    italic = true;
    italicCloseAt = close;
    pos += 1;
    return true;
  }

  /// The index of the next [marker] that can close a span opened before
  /// [from]: one with non-empty, non-whitespace-ending content before it.
  int _closingIndex(String marker, int from, {bool wordBoundary = false}) {
    var search = from;
    while (true) {
      final index = text.indexOf(marker, search);
      if (index == -1) return -1;
      final inside = index > from && !_isSpace(text[index - 1]);
      final after = index + marker.length;
      final boundary =
          !wordBoundary || after >= text.length || !_isWordChar(text[after]);
      // `*` inside `**` is the bold pair's, unless we are looking for `**`.
      final partOfPair =
          marker == '*' && after < text.length && text[after] == '*';
      if (inside && boundary && !partOfPair) return index;
      search = index + 1;
    }
  }

  static bool _isSpace(String ch) => ch.trim().isEmpty;

  static bool _isWordChar(String ch) {
    final code = ch.codeUnitAt(0);
    return (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code == 0x5f ||
        code > 0x7f && ch.trim().isNotEmpty;
  }
}

/// The message with its markup removed, for previews, quotes and the
/// clipboard. Lists keep a marker so a copied list still reads as one;
/// citations are the app's affordance, not text, and are dropped.
/// Twin of `chatMessagePlainText` in `apps/api/src/chatMessagePlainText.ts`; they must agree.
String chatMessagePlainText(String text) => parseChatMarkdown(
  text,
).map((block) => block.plainTextLine).join('\n').trim();

/// Assistant turns (anything that is not the user) render and strip light
/// markdown. A user's own text stays as typed — people type asterisks.
bool chatRoleUsesMarkdown(String role) => role.toLowerCase() != 'user';

/// Copy/actions-menu text: user bubbles stay verbatim; assistant bubbles
/// go through [chatMessagePlainText] so the clipboard gets prose, not markup.
String chatBubbleCopyText(String content, {required String role}) =>
    chatRoleUsesMarkdown(role) ? chatMessagePlainText(content) : content;

String _inlineText(List<ChatInline> inlines) => inlines
    .map((inline) => inline.text)
    .join()
    .replaceAll(RegExp(r' {2,}'), ' ')
    .trim();
