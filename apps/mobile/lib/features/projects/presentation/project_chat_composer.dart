import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/chat_text_direction.dart';
import 'chat_reply_quote.dart';
import 'plan_build_progress.dart';

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
    this.focusNode,
    super.key,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final String? lockedLabel;
  final ChatReplyTarget? replyTarget;
  final VoidCallback? onOpenReply;
  final VoidCallback? onCancelReply;

  /// Lets the screen put the cursor in the field after filling it from a
  /// suggestion.
  final FocusNode? focusNode;

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
          focusNode: focusNode,
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
          textCapitalization: TextCapitalization.sentences,
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
            AppButton.text(
              onPressed: submitting ? null : onCancel,
              label: 'Cancel',
            ),
            AppButton.primary(
              onPressed: submitting ? null : onSubmit,
              loading: submitting,
              loadingLabel: 'Saving & submitting',
              leading: const Icon(Icons.send_outlined),
              label: 'Save & Submit',
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
    this.focusNode,
    super.key,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final FocusNode? focusNode;

  /// Why the composer is closed, or null while it is open.
  ///
  /// Set while the worker is rebuilding the book: nothing new can start until
  /// that settles, so the field says what it is waiting on instead of taking
  /// text that has nowhere to go. Whatever is already typed stays put.
  final String? lockedLabel;

  Widget _field({
    required ColorScheme colors,
    required bool locked,
    required OutlineInputBorder border,
    required TextDirection? direction,
  }) {
    return TextField(
      controller: controller,
      focusNode: focusNode,
      enabled: !locked,
      minLines: 1,

      maxLines: 5,
      textCapitalization: TextCapitalization.sentences,
      textInputAction: TextInputAction.newline,
      textDirection: direction,
      decoration: InputDecoration(
        hintText: lockedLabel ?? 'Ask or request an edit…',
        filled: true,
        fillColor: locked
            ? colors.surfaceContainerLow
            : colors.surfaceContainerLowest,
        contentPadding: const EdgeInsetsDirectional.fromSTEB(
          AppSpacing.md,
          14,
          AppSpacing.md,
          14,
        ),
        // While the book is being rebuilt the field says so, and
        // the sparkle only turns for as long as that is true.
        prefixIcon: locked
            ? Padding(
                padding: const EdgeInsetsDirectional.only(
                  start: AppSpacing.sm,
                  end: AppSpacing.xs,
                ),
                child: Center(
                  widthFactor: 1,
                  child: ExcludeSemantics(
                    child: PlanBuildSparkle(color: colors.primary, size: 20),
                  ),
                ),
              )
            : null,
        border: border,
        enabledBorder: border,
        disabledBorder: border,
        focusedBorder: border.copyWith(
          borderSide: BorderSide(color: colors.primary, width: 1.6),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final locked = lockedLabel != null;
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppRadii.card + 6),
      borderSide: BorderSide(color: colors.outlineVariant),
    );
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.surface,
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.sm,
            AppSpacing.xs + 2,
            AppSpacing.sm,
            AppSpacing.sm,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                // Typing Persian or Arabic in an English UI: the field follows
                // the language being typed, as the creation composer and the
                // bubbles it produces do.
                child: ValueListenableBuilder<TextEditingValue>(
                  valueListenable: controller,
                  builder: (context, value, _) => _field(
                    colors: colors,
                    locked: locked,
                    border: border,
                    direction: switch (chatTextDirection(value.text)) {
                      TextDirectionHint.rtl => TextDirection.rtl,
                      TextDirectionHint.ltr => TextDirection.ltr,
                      null => null,
                    },
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              // The label lives on the button's own child, not on a wrapper: a
              // FilledButton is its own semantics container, so a label on a
              // parent lands on a node nobody can activate and leaves the real
              // button unnamed to a screen reader.
              Tooltip(
                message: 'Send message',
                excludeFromSemantics: true,
                child: SizedBox.square(
                  dimension: AppSizes.minimumTouchTarget + 4,
                  child: FilledButton(
                    // Compact icon-only composer control: its geometry is
                    // intentionally distinct from ordinary labelled actions.
                    style: FilledButton.styleFrom(
                      padding: EdgeInsets.zero,
                      minimumSize: Size.square(AppSizes.minimumTouchTarget + 4),
                      shape: const CircleBorder(),
                    ),
                    onPressed: sending || locked ? null : onSend,
                    child: sending
                        ? const SizedBox.square(
                            dimension: AppSizes.buttonProgressIndicator,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              semanticsLabel: 'Sending message',
                            ),
                          )
                        : const Icon(
                            Icons.send_outlined,
                            semanticLabel: 'Send message',
                          ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
