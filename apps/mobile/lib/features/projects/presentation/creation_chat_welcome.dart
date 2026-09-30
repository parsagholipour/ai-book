part of 'creation_chat_screen.dart';

// What a brand-new chat says before anyone has typed: the promise, a few ideas
// to start from, and the two things that make the first message better (a file,
// a saved character). It stands in for the transcript while the conversation has
// not begun and is gone the moment it does. Imports and shared state live in the
// parent library file.

/// Whether the chat is still a blank page.
///
/// A saved session is never blank, whatever it holds — the welcome is for a chat
/// that has not been persisted yet, which is exactly the "New book" the reader
/// opened a moment ago. Anything that means work has begun (a message of their
/// own, a file in the composer, a question waiting, a reply on its way) ends it.
bool _showsWelcome(CreationChatState state, {required bool isInOutputStage}) {
  if (isInOutputStage || state.initializing) return false;
  if (state.hasSession || state.archived) return false;
  if (state.messages.any((message) => message.isUser)) return false;
  return !state.isBusy &&
      state.question == null &&
      state.pendingAttachments.isEmpty &&
      state.outputs.isEmpty;
}

/// The examples the welcome offers. The greeting turn carries the server's own
/// (`quickReplies`), so they are used first; the local list is the same set for
/// a payload that arrives without any.
List<String> _welcomeIdeas(CreationChatState state) {
  final offered = [
    for (final idea in state.quickReplies)
      if (idea.trim().isNotEmpty) idea.trim(),
  ];
  return offered.isNotEmpty
      ? offered
      : creationChatLocalGreetingTurn.quickReplies;
}

IconData _welcomeIdeaIcon(String idea) {
  final text = idea.toLowerCase();
  bool has(List<String> words) => words.any(text.contains);
  if (has(['bedtime', 'kid', 'child', 'toddler'])) {
    return Icons.bedtime_outlined;
  }
  if (has(['lead magnet', 'pricing', 'marketing', 'newsletter'])) {
    return Icons.campaign_outlined;
  }
  if (has(['workbook', 'worksheet', 'course', 'coach', 'lesson'])) {
    return Icons.edit_note_outlined;
  }
  if (has(['story', 'novel', 'mystery', 'fiction', 'fantasy'])) {
    return Icons.auto_stories_outlined;
  }
  if (has(['guide', 'how to', 'handbook', 'manual'])) {
    return Icons.menu_book_outlined;
  }
  if (has(['memoir', 'family', 'gift', 'wedding'])) {
    return Icons.favorite_border;
  }
  return Icons.auto_awesome_outlined;
}

class _ChatWelcome extends StatelessWidget {
  const _ChatWelcome({
    required this.greeting,
    required this.ideas,
    required this.onPickIdea,
    required this.onAttach,
    required this.onMention,
    super.key,
  });

  /// The assistant's own opening line, shown as the lead paragraph instead of a
  /// bubble: a lone bubble on an empty page reads as an error, not a greeting.
  final String greeting;
  final List<String> ideas;
  final ValueChanged<String> onPickIdea;
  final VoidCallback onAttach;
  final VoidCallback onMention;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return ListView(
      key: const ValueKey('creation-welcome'),
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsetsDirectional.fromSTEB(20, 20, 20, 12),
      children: [
        AppEntrance(
          offset: 10,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.primaryContainer,
                      borderRadius: BorderRadius.circular(AppRadii.control),
                    ),
                    child: SizedBox.square(
                      dimension: 48,
                      child: Center(
                        child: TomezaBrandMark(
                          size: 28,
                          color: colors.onPrimaryContainer,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        'Turn an idea into a book',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                          height: 1.2,
                          letterSpacing: -0.3,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              ChatMessageText.forRole(
                greeting,
                role: 'assistant',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                'Try an idea',
                style: theme.textTheme.labelLarge?.copyWith(
                  color: colors.onSurfaceVariant,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              for (final idea in ideas) ...[
                _WelcomeIdeaCard(idea: idea, onTap: () => onPickIdea(idea)),
                const SizedBox(height: 6),
              ],
              const _WelcomeStudioLink(),
              _WelcomeTip(
                icon: Icons.attach_file_outlined,
                text: 'Add notes, a document or a photo and I read it first.',
                onTap: onAttach,
              ),
              _WelcomeTip(
                icon: Icons.alternate_email,
                text: 'Type @ to bring a saved character into your book.',
                onTap: onMention,
              ),
              const _WelcomeTip(
                icon: Icons.fact_check_outlined,
                text: 'You review the plan before any pages are written.',
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _WelcomeIdeaCard extends StatelessWidget {
  const _WelcomeIdeaCard({required this.idea, required this.onTap});

  final String idea;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Material(
      color: colors.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.control),
        side: BorderSide(color: colors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                AppHaptics.selection();
                onTap!();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: AppSizes.minimumTouchTarget + 4,
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(10, 8, 10, 8),
            child: Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.primaryContainer.withValues(alpha: 0.7),
                    shape: BoxShape.circle,
                  ),
                  child: SizedBox.square(
                    dimension: 34,
                    child: Icon(
                      _welcomeIdeaIcon(idea),
                      size: 19,
                      color: colors.primary,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    idea,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.xs),
                Icon(
                  Icons.chevron_right,
                  size: 20,
                  color: colors.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The side door for people who want to write the book themselves. One line,
/// link weight: the ideas above are what this screen is for, and a second
/// button beside them would make every visitor choose between two roads.
class _WelcomeStudioLink extends StatelessWidget {
  const _WelcomeStudioLink();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = theme.textTheme.bodySmall?.copyWith(
      color: colors.onSurfaceVariant,
      height: 1.35,
    );
    return Semantics(
      button: true,
      label: 'Rather write it yourself? Open the Writing Studio',
      child: ExcludeSemantics(
        child: InkWell(
          key: const ValueKey('welcome-writing-studio'),
          onTap: () => showStartWritingSheet(context),
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(4, 6, 4, 6),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text.rich(
                  TextSpan(
                    children: [
                      const TextSpan(text: 'Rather write it yourself? '),
                      TextSpan(
                        text: 'Open the Writing Studio →',
                        style: TextStyle(
                          color: colors.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  style: style,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _WelcomeTip extends StatelessWidget {
  const _WelcomeTip({required this.icon, required this.text, this.onTap});

  final IconData icon;
  final String text;

  /// Null for a tip that is only information.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadii.compact),
      child: ConstrainedBox(
        // A tip that acts is a tap target; one that only informs stays compact.
        constraints: BoxConstraints(minHeight: onTap == null ? 40 : 48),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(4, 5, 4, 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(
                  icon,
                  size: 20,
                  color: onTap == null
                      ? colors.onSurfaceVariant
                      : colors.primary,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  text,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    height: 1.35,
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

/// The assistant's opening line: the greeting the server (or the local turn)
/// put in the transcript, or the local wording when there is none.
String _welcomeGreeting(CreationChatState state) {
  for (final message in state.messages) {
    if (!message.isUser && message.content.trim().isNotEmpty) {
      return message.content;
    }
  }
  return creationChatLocalGreetingText;
}

/// What stands in for the chat while it loads.
///
/// A cold start has no conversation cached, so this is the first thing many
/// sessions show. It is drawn as the transcript will be — an assistant bubble
/// with its avatar, a shorter one of the reader's own, another assistant reply —
/// so the page fills in rather than replaces itself.
class _ChatSkeleton extends StatelessWidget {
  const _ChatSkeleton();

  static Widget _assistant(double widthFactor, double height) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const AppSkeleton.circle(size: ChatAssistantAvatar.size),
      const SizedBox(width: 8),
      Expanded(
        child: FractionallySizedBox(
          alignment: AlignmentDirectional.centerStart,
          widthFactor: widthFactor,
          child: AppSkeleton.box(height: height, radius: 18),
        ),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: 'Loading chat',
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        // Clips rather than overflows when the keyboard leaves less height
        // than the three bubbles need.
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _assistant(0.78, 84),
              const SizedBox(height: 18),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: FractionallySizedBox(
                  widthFactor: 0.5,
                  child: const AppSkeleton.box(height: 44, radius: 18),
                ),
              ),
              const SizedBox(height: 18),
              _assistant(0.9, 112),
            ],
          ),
        ),
      ),
    );
  }
}
