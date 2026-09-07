import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';

/// The form scrolls independently of its save action, including with a
/// keyboard open or larger system text. The sheet owns the available height.
class CharacterEditorLayout extends StatelessWidget {
  const CharacterEditorLayout({
    required this.creating,
    required this.busy,
    required this.saving,
    required this.onClose,
    required this.onSave,
    required this.children,
    super.key,
  });

  final bool creating;
  final bool busy;
  final bool saving;
  final VoidCallback onClose;
  final VoidCallback onSave;
  final List<Widget> children;

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
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            creating ? 'New character' : 'Edit character',
                            style: theme.textTheme.headlineSmall,
                          ),
                        ),
                        IconButton(
                          tooltip: 'Close editor',
                          onPressed: busy ? null : onClose,
                          icon: const Icon(Icons.close_rounded),
                        ),
                      ],
                    ),
                    Text(
                      creating
                          ? 'Start with a name. Add what makes them unforgettable.'
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
                child: AppButton.primary(
                  key: const ValueKey('character-editor-save'),
                  label: creating ? 'Create character' : 'Save changes',
                  leading: Icon(
                    creating ? Icons.add_rounded : Icons.check_rounded,
                  ),
                  loading: saving,
                  expanded: true,
                  onPressed: busy ? null : onSave,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
