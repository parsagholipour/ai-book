import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';

/// The form scrolls independently of its title and its save action, including
/// with a keyboard open or larger system text. The sheet owns the available
/// height.
///
/// The title and close button stay put while the form scrolls: a long form that
/// carried its own exit off the top of the screen made "where do I leave" a
/// question that needed a scroll back up to answer.
class CharacterEditorLayout extends StatelessWidget {
  const CharacterEditorLayout({
    required this.creating,
    required this.busy,
    required this.saving,
    required this.onClose,
    required this.onSave,
    required this.children,
    this.savingLabel,
    this.notice,
    this.onDismissNotice,
    super.key,
  });

  final bool creating;
  final bool busy;
  final bool saving;
  final VoidCallback onClose;
  final VoidCallback onSave;
  final List<Widget> children;

  /// What the save button says while it works. Defaults to "Creating…" or
  /// "Saving…"; a create that goes on to upload a photo says so.
  final String? savingLabel;

  /// Why the last thing the reader tried did not happen, said above the save
  /// button. A snack bar cannot say it: the messenger shows one on the page's
  /// Scaffold, and this sheet covers that page — a failed Create spun, stopped,
  /// and showed nothing at all.
  final ({String title, String message})? notice;
  final VoidCallback? onDismissNotice;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.88,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 8, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        creating ? 'New character' : 'Edit character',
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close editor',
                    onPressed: busy ? null : onClose,
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      creating
                          ? 'Start with a face and a name. Add what makes them '
                                'unforgettable.'
                          : 'The little details make them feel like themselves.',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    ...children,
                  ],
                ),
              ),
            ),
            DecoratedBox(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: theme.colorScheme.outlineVariant),
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (notice case final notice?) ...[
                      AppInlineNotice(
                        key: const ValueKey('character-editor-notice'),
                        tone: AppTone.error,
                        title: notice.title,
                        message: notice.message,
                        onDismiss: onDismissNotice,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                    ],
                    AppButton.primary(
                      key: const ValueKey('character-editor-save'),
                      label: creating ? 'Create character' : 'Save changes',
                      loadingLabel:
                          savingLabel ?? (creating ? 'Creating…' : 'Saving…'),
                      leading: Icon(
                        creating ? Icons.add_rounded : Icons.check_rounded,
                      ),
                      loading: saving,
                      expanded: true,
                      onPressed: busy ? null : onSave,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
