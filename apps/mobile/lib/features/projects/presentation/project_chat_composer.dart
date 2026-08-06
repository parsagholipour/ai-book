import 'package:flutter/material.dart';

import 'chat_reply_quote.dart';

// The chat's text-entry widgets: the bottom composer with the strip that names
// what it is replying to, and the inline editor a sent message turns into when
// it is edited.

/// The composer plus its context strip.
///
/// The two are one widget because the strip is part of the text-entry area: it
/// has to sit directly above the field, inside the same `SafeArea`, or the
/// keyboard insets push them apart.
class ProjectChatComposerBar extends StatelessWidget {
  const ProjectChatComposerBar({
    required this.controller,
    required this.sending,
    required this.onSend,
    this.lockedLabel,
    this.replyTarget,
    this.onOpenReply,
    this.onCancelReply,
    super.key,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final String? lockedLabel;
  final ChatReplyTarget? replyTarget;
  final VoidCallback? onOpenReply;
  final VoidCallback? onCancelReply;

  @override
  Widget build(BuildContext context) {
    final target = replyTarget;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (target != null && onOpenReply != null && onCancelReply != null)
          ChatComposerContextBanner.replying(
            target: target,
            onOpen: onOpenReply!,
            onCancel: onCancelReply!,
          ),
        ProjectChatComposer(
          controller: controller,
          sending: sending,
          onSend: onSend,
          lockedLabel: lockedLabel,
        ),
      ],
    );
  }
}

class InlineMessageEditor extends StatelessWidget {
  const InlineMessageEditor({
    required this.controller,
    required this.submitting,
    this.onCancel,
    this.onSubmit,
    super.key,
  });

  final TextEditingController controller;
  final bool submitting;
  final VoidCallback? onCancel;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: controller,
          autofocus: true,
          minLines: 1,
          maxLines: 6,
          textInputAction: TextInputAction.newline,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          runSpacing: 8,
          children: [
            TextButton(
              onPressed: submitting ? null : onCancel,
              child: const Text('Cancel'),
            ),
            FilledButton.icon(
              onPressed: submitting ? null : onSubmit,
              icon: submitting
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send_outlined),
              label: const Text('Save & Submit'),
            ),
          ],
        ),
      ],
    );
  }
}

class ProjectChatComposer extends StatelessWidget {
  const ProjectChatComposer({
    required this.controller,
    required this.sending,
    required this.onSend,
    this.lockedLabel,
    super.key,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  /// Why the composer is closed, or null while it is open.
  ///
  /// Set while the worker is rebuilding the book: nothing new can start until
  /// that settles, so the field says what it is waiting on instead of taking
  /// text that has nowhere to go. Whatever is already typed stays put.
  final String? lockedLabel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final locked = lockedLabel != null;
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surface,
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  enabled: !locked,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: lockedLabel ?? 'Ask or request an edit…',
                    border: const OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: sending || locked ? null : onSend,
                child: sending
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send_outlined),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
