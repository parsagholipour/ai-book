import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/chat_markdown.dart';

/// The one message box the chat draws: an optional attach button, a text field
/// that grows with what is typed, and a send button, inside a single rounded
/// field so the three read as one control rather than three neighbours.
///
/// It owns presentation only. The screen keeps the controller, the focus node
/// and every decision about *whether* a message may go: [canSendWithoutText]
/// and [holdSend] are handed in, because "empty" is not the whole answer (an
/// attachment can stand in for text, and a file still being read holds the send
/// back).
///
/// The text field stays a plain [TextField] and the send button an
/// [IconButton], so the suites that reach into them keep working.
class ChatComposerField extends StatefulWidget {
  const ChatComposerField({
    required this.controller,
    required this.hintText,
    required this.onSend,
    super.key,
    this.focusNode,
    this.enabled = true,
    this.canSendWithoutText = false,
    this.holdSend = false,
    this.busy = false,
    this.sendTooltip = 'Send',
    this.onAttach,
    this.attachTooltip = 'Attach a photo, document, or notes',
    this.attachEnabled = true,
    this.attachActive = false,
    this.maxLength,
    this.maxLines = 6,
  });

  final TextEditingController controller;
  final String hintText;

  /// Called with the composer's text. Only ever fired while the send button is
  /// open: text (or [canSendWithoutText]), not [holdSend], within [maxLength].
  final ValueChanged<String> onSend;
  final FocusNode? focusNode;

  /// False greys the field out and stops typing (a reply is on its way, or the
  /// book cannot take a message right now).
  final bool enabled;

  /// A ready attachment stands in for text, like handing a file to a person.
  final bool canSendWithoutText;

  /// Something is still being read; sending now would leave it behind.
  final bool holdSend;

  /// A reply is being fetched: the send button shows progress instead of an
  /// arrow, so the wait has a face.
  final bool busy;
  final String sendTooltip;

  /// Null hides the attach button (the output-stage box has nothing to attach).
  final VoidCallback? onAttach;
  final String attachTooltip;

  /// The paperclip can be shut on its own, for a moment the box still takes
  /// text but a file has nowhere to go.
  final bool attachEnabled;

  /// Something is already attached, so the paperclip wears the brand colour.
  final bool attachActive;

  /// The most the server accepts. Shown only when the text gets close — a
  /// counter that is always there teaches people to ignore it — and once past
  /// it the send button closes instead of the request failing on the wire.
  final int? maxLength;
  final int maxLines;

  /// Length at which the counter appears, as a share of [maxLength].
  static const counterThreshold = 0.85;

  @override
  State<ChatComposerField> createState() => _ChatComposerFieldState();
}

class _ChatComposerFieldState extends State<ChatComposerField> {
  FocusNode? _ownFocus;

  FocusNode get _focus =>
      widget.focusNode ??
      (_ownFocus ??= FocusNode(debugLabel: 'chat-composer'));

  @override
  void initState() {
    super.initState();
    _focus.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(covariant ChatComposerField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownFocus)?.removeListener(_onFocusChanged);
      _focus.addListener(_onFocusChanged);
    }
  }

  @override
  void dispose() {
    _focus.removeListener(_onFocusChanged);
    _ownFocus?.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final focused = _focus.hasFocus && widget.enabled;
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: widget.controller,
      builder: (context, value, _) {
        final length = value.text.characters.length;
        final max = widget.maxLength;
        final overLimit = max != null && length > max;
        final showCounter =
            max != null && length >= max * ChatComposerField.counterThreshold;
        final hasText = value.text.trim().isNotEmpty;
        final hasContent = hasText || widget.canSendWithoutText;
        final sendable =
            widget.enabled &&
            !widget.holdSend &&
            hasContent &&
            !overLimit &&
            !widget.busy;
        // Composing in Persian inside an English UI: the field follows the
        // language being typed, the way the bubbles it produces do.
        final direction = switch (chatTextDirection(value.text)) {
          TextDirectionHint.rtl => TextDirection.rtl,
          TextDirectionHint.ltr => TextDirection.ltr,
          null => null,
        };
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AnimatedContainer(
              duration: AppMotion.fast,
              curve: AppMotion.standard,
              decoration: BoxDecoration(
                color: widget.enabled
                    ? colors.surfaceContainerHigh
                    : colors.surfaceContainerLow,
                borderRadius: BorderRadius.circular(26),
                border: Border.all(
                  color: overLimit
                      ? colors.error
                      : focused
                      ? colors.primary
                      : colors.outlineVariant,
                  width: focused || overLimit ? 1.6 : 1,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (widget.onAttach != null)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(start: 2),
                      child: IconButton(
                        tooltip: widget.attachTooltip,
                        onPressed: widget.enabled && widget.attachEnabled
                            ? widget.onAttach
                            : null,
                        icon: Icon(
                          widget.attachActive
                              ? Icons.attach_file
                              : Icons.attach_file_outlined,
                          color: widget.attachActive ? colors.primary : null,
                        ),
                      ),
                    )
                  else
                    const SizedBox(width: 10),
                  Expanded(
                    child: TextField(
                      controller: widget.controller,
                      focusNode: _focus,
                      enabled: widget.enabled,
                      minLines: 1,
                      maxLines: widget.maxLines,
                      textDirection: direction,
                      textInputAction: TextInputAction.newline,
                      keyboardType: TextInputType.multiline,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        hintText: widget.hintText,
                        hintMaxLines: 1,
                        filled: false,
                        isDense: true,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        disabledBorder: InputBorder.none,
                        errorBorder: InputBorder.none,
                        focusedErrorBorder: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 15,
                        ),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsetsDirectional.only(
                      start: 4,
                      end: 6,
                      bottom: 4,
                      top: 4,
                    ),
                    child: _SendButton(
                      tooltip: widget.sendTooltip,
                      busy: widget.busy,
                      active: hasContent,
                      onPressed: sendable
                          ? () => widget.onSend(widget.controller.text)
                          : null,
                    ),
                  ),
                ],
              ),
            ),
            if (showCounter)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: 4, end: 14),
                child: Semantics(
                  liveRegion: overLimit,
                  child: Text(
                    overLimit
                        ? '$length / $max · too long to send'
                        : '$length / $max',
                    textAlign: TextAlign.end,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: overLimit ? colors.error : colors.onSurfaceVariant,
                      fontWeight: overLimit ? FontWeight.w700 : null,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// The circular send control. The arrow stays in the tree while a reply is
/// pending (only hidden), so what the button *is* never changes under a screen
/// reader or a test — the spinner is drawn over it.
class _SendButton extends StatelessWidget {
  const _SendButton({
    required this.tooltip,
    required this.busy,
    required this.active,
    required this.onPressed,
  });

  final String tooltip;
  final bool busy;
  final bool active;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return IconButton.filled(
      tooltip: tooltip,
      onPressed: onPressed == null
          ? null
          : () {
              AppHaptics.tap();
              onPressed!();
            },
      style: IconButton.styleFrom(
        minimumSize: const Size.square(44),
        fixedSize: const Size.square(44),
        disabledBackgroundColor: busy
            ? colors.primaryContainer
            : active
            ? colors.surfaceContainerHighest
            : colors.surfaceContainerHighest.withValues(alpha: 0.6),
        disabledForegroundColor: colors.onSurfaceVariant.withValues(alpha: 0.6),
      ),
      icon: Stack(
        alignment: Alignment.center,
        children: [
          Opacity(
            opacity: busy ? 0 : 1,
            child: const Icon(Icons.send_rounded, size: 22),
          ),
          if (busy)
            SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2.2,
                color: colors.onPrimaryContainer,
              ),
            ),
        ],
      ),
    );
  }
}
