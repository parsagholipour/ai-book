import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';

/// One thing the book chat can be asked, offered as a starting point.
///
/// Tapping it fills the composer rather than sending: every suggestion is a
/// sentence with a gap the reader still has to fill ("Rewrite page _ so it
/// sounds warmer"), and a message that goes out half-written is worse than one
/// that waits.
@immutable
class ChatSuggestion {
  const ChatSuggestion({
    required this.icon,
    required this.title,
    required this.example,
    required this.prefix,
    this.suffix = '',
  });

  final IconData icon;
  final String title;

  /// A whole example sentence, shown under the title so the reader can see the
  /// shape of a good request.
  final String example;

  /// The text the composer is filled with, up to where the cursor goes…
  final String prefix;

  /// …and whatever follows the cursor.
  final String suffix;
}

/// What a finished book can be asked to do, in the order people reach for it.
///
/// Each maps onto something the chat really does; a suggestion the chat cannot
/// carry out would be a dead end with a button on it.
const projectChatSuggestions = <ChatSuggestion>[
  ChatSuggestion(
    icon: Icons.auto_fix_high_outlined,
    title: 'Rewrite a page',
    example: 'Rewrite page 3 so it sounds warmer',
    prefix: 'Rewrite page ',
    suffix: ' so it sounds warmer',
  ),
  ChatSuggestion(
    icon: Icons.add_photo_alternate_outlined,
    title: 'Add a picture',
    example: 'Add a picture of the lighthouse at night',
    prefix: 'Add a picture of ',
  ),
  ChatSuggestion(
    icon: Icons.post_add,
    title: 'Add a chapter',
    example: 'Add a chapter about what happens next',
    prefix: 'Add a chapter about ',
  ),
  ChatSuggestion(
    icon: Icons.flag_outlined,
    title: 'Change the ending',
    example: 'Change the ending so it feels more hopeful',
    prefix: 'Change the ending so it ',
  ),
  ChatSuggestion(
    icon: Icons.tips_and_updates_outlined,
    title: 'Ask for advice',
    example: 'What should I improve in this book?',
    prefix: 'What should I improve in this book?',
  ),
];

/// The top of a book chat that has nothing in it yet.
///
/// For a finished book that is an invitation with things to tap. For a book
/// that is still being planned or written it is one short notice saying what
/// the chat can do at that stage — and, once the transcript has messages, only
/// that notice remains, so the guidance never sits above a long conversation.
class ProjectChatWelcome extends StatelessWidget {
  const ProjectChatWelcome({
    required this.project,
    required this.onSuggestion,
    super.key,
  });

  final MobileProjectDetail? project;
  final ValueChanged<ChatSuggestion> onSuggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return AppEntrance(
      offset: 8,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: colors.primaryContainer,
                    borderRadius: BorderRadius.circular(AppRadii.control),
                  ),
                  child: Icon(
                    Icons.auto_fix_high_outlined,
                    color: colors.onPrimaryContainer,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        'Talk to your book',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      'Ask a question, or ask for a change. Anything that '
                      'costs credits shows its price and waits for your OK '
                      'before it runs.',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          Semantics(
            header: true,
            child: Text(
              'Try asking',
              style: theme.textTheme.labelLarge?.copyWith(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          for (final suggestion in projectChatSuggestions) ...[
            _SuggestionTile(
              suggestion: suggestion,
              onTap: () {
                AppHaptics.selection();
                onSuggestion(suggestion);
              },
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
        ],
      ),
    );
  }
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({required this.suggestion, required this.onTap});

  final ChatSuggestion suggestion;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      button: true,
      label: '${suggestion.title}. ${suggestion.example}',
      hint: 'Adds this to your message',
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: colors.surfaceContainerLowest,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.control),
            side: BorderSide(color: colors.outlineVariant),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 60),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.sm,
                  vertical: AppSpacing.xs + 2,
                ),
                child: Row(
                  children: [
                    Icon(suggestion.icon, size: 22, color: colors.primary),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            suggestion.title,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            suggestion.example,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// What the chat can do while the book is not finished.
///
/// One notice, always shown above the transcript at these stages: unlike the
/// finished-book welcome it is a limit the reader needs to keep in sight, not
/// an invitation.
class ProjectChatStageNotice extends StatelessWidget {
  const ProjectChatStageNotice({required this.project, super.key});

  final MobileProjectDetail? project;

  @override
  Widget build(BuildContext context) {
    final planReady = project?.status == 'plan_ready';
    return AppInlineNotice(
      icon: planReady ? Icons.edit_note_outlined : Icons.hourglass_top_outlined,
      title: planReady ? 'Shape the plan' : 'Ask away',
      message: planReady
          ? 'Ask questions or request plan changes. Plan edits use credits.'
          : 'You can ask questions now. Editing unlocks after planning or '
                'generation reaches the right stage.',
    );
  }
}
