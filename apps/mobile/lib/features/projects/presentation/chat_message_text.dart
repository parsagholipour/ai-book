import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../domain/chat_markdown.dart';
import 'source_citations.dart';

/// The text of one chat bubble.
///
/// Assistant replies are light markdown (see `chat_markdown.dart`): bold,
/// numbered and bulleted lists with a hanging indent, headings, quotes, code,
/// links and the server's citation tokens, which open the cited passage. A
/// user's own message is shown verbatim — people type asterisks.
///
/// The bubble is laid out in the direction of the message's first strong
/// character, so a Persian reply in an English UI reads from the right and
/// its list markers sit on the right, whatever the surrounding layout does.
class ChatMessageText extends ConsumerStatefulWidget {
  const ChatMessageText(
    this.text, {
    super.key,
    this.style,
    this.markdown = true,
  });

  ChatMessageText.forRole(
    this.text, {
    super.key,
    this.style,
    required String role,
  }) : markdown = chatRoleUsesMarkdown(role);

  final String text;
  final TextStyle? style;
  final bool markdown;

  @override
  ConsumerState<ChatMessageText> createState() => _ChatMessageTextState();
}

class _ChatMessageTextState extends ConsumerState<ChatMessageText> {
  final List<TapGestureRecognizer> _recognizers = [];

  @override
  void dispose() {
    _disposeRecognizers();
    super.dispose();
  }

  void _disposeRecognizers() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
  }

  @override
  Widget build(BuildContext context) {
    _disposeRecognizers();
    final theme = Theme.of(context);
    final base = (theme.textTheme.bodyMedium ?? const TextStyle()).merge(
      widget.style,
    );
    final direction = switch (chatTextDirection(widget.text)) {
      TextDirectionHint.rtl => TextDirection.rtl,
      TextDirectionHint.ltr => TextDirection.ltr,
      null => Directionality.of(context),
    };
    final blocks = widget.markdown
        ? parseChatMarkdown(widget.text)
        : [
            ChatParagraph([ChatInline(widget.text)]),
          ];
    final citations = _CitationNumbering(blocks);
    final children = <Widget>[];
    ChatBlock? previous;
    for (final block in blocks) {
      if (previous != null) {
        final tight = previous is ChatListItem && block is ChatListItem;
        children.add(SizedBox(height: tight ? 3 : 8));
      }
      children.add(_block(context, block, base, citations));
      previous = block;
    }
    final body = children.length == 1
        ? children.single
        : Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: children,
          );
    return Directionality(textDirection: direction, child: body);
  }

  Widget _block(
    BuildContext context,
    ChatBlock block,
    TextStyle base,
    _CitationNumbering citations,
  ) {
    final ink = base.color ?? Theme.of(context).colorScheme.onSurface;
    switch (block) {
      case ChatParagraph(:final inlines):
        return _rich(context, inlines, base, citations);
      case ChatHeading(:final inlines):
        return _rich(
          context,
          inlines,
          base.copyWith(
            fontWeight: FontWeight.w700,
            fontSize: (base.fontSize ?? 14) + 1,
          ),
          citations,
        );
      case ChatQuote(:final inlines):
        return Container(
          padding: const EdgeInsetsDirectional.only(start: 10),
          decoration: BoxDecoration(
            border: BorderDirectional(
              start: BorderSide(color: ink.withValues(alpha: 0.35), width: 3),
            ),
          ),
          child: _rich(
            context,
            inlines,
            base.copyWith(color: ink.withValues(alpha: 0.85)),
            citations,
          ),
        );
      case ChatCodeBlock(:final code):
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: ink.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(8),
          ),
          // Code is always left-to-right, whatever language the reply is in.
          child: Directionality(
            textDirection: TextDirection.ltr,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Text(code, style: _mono(base)),
            ),
          ),
        );
      case ChatListItem(
        :final ordered,
        :final marker,
        :final inlines,
      ):
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(minWidth: ordered ? 22 : 12),
              child: Text(
                ordered ? marker : '•',
                style: base,
                // Hugs the item text: right in LTR, left in RTL.
                textAlign: TextAlign.end,
              ),
            ),
            const SizedBox(width: 6),
            Expanded(child: _rich(context, inlines, base, citations)),
          ],
        );
    }
  }

  Widget _rich(
    BuildContext context,
    List<ChatInline> inlines,
    TextStyle base,
    _CitationNumbering citations,
  ) {
    return Text.rich(
      TextSpan(
        children: [for (final inline in inlines) _span(inline, base, citations)],
      ),
      style: base,
    );
  }

  InlineSpan _span(
    ChatInline inline,
    TextStyle base,
    _CitationNumbering citations,
  ) {
    final citation = inline.citation;
    if (citation != null) {
      return WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: InkWell(
          onTap: () => openSourcePassage(context, ref, citation),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              '[Source ${citations.numberOf(citation)}]',
              style: base.copyWith(decoration: TextDecoration.underline),
            ),
          ),
        ),
      );
    }
    var style = base;
    if (inline.bold) style = style.copyWith(fontWeight: FontWeight.w700);
    if (inline.italic) style = style.copyWith(fontStyle: FontStyle.italic);
    final url = inline.linkUrl;
    if (url == null) return TextSpan(text: inline.text, style: style);
    final recognizer = TapGestureRecognizer()
      ..onTap = () => _openLink(url);
    _recognizers.add(recognizer);
    return TextSpan(
      text: inline.text,
      style: style.copyWith(decoration: TextDecoration.underline),
      recognizer: recognizer,
    );
  }

  Future<void> _openLink(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  static TextStyle _mono(TextStyle base) => base.copyWith(
    fontFamily: 'monospace',
    fontFamilyFallback: const ['Menlo', 'Courier New', 'Courier'],
    fontSize: (base.fontSize ?? 14) - 1,
  );
}

/// Citations are labelled `[Source N]` in order of first appearance across
/// the whole message, so the same passage cited twice shows one number.
class _CitationNumbering {
  _CitationNumbering(List<ChatBlock> blocks) {
    for (final block in blocks) {
      for (final inline in block.inlines) {
        final citation = inline.citation;
        if (citation != null) _numbers.putIfAbsent(_key(citation), () => _numbers.length + 1);
      }
    }
  }

  final Map<String, int> _numbers = {};

  int numberOf(ChatCitation citation) => _numbers[_key(citation)] ?? 1;

  static String _key(ChatCitation citation) =>
      '${citation.sourceId}:${citation.version}:${citation.passage}';
}
