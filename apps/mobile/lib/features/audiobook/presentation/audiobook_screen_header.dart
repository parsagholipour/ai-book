part of 'audiobook_screen.dart';

/// Where the listener is in the book, by name: the chapter playing now and how
/// far through the list it is. Null until there are chapters to name.
({String title, int position, int count})? _currentChapterOf(
  AudiobookState state,
) {
  final chapters = state.timeline?.chapters ?? const [];
  if (chapters.isEmpty) {
    return null;
  }
  var at = chapters.indexWhere(
    (chapter) => chapter.index == state.chapterIndex,
  );
  if (at < 0) {
    at = 0;
  }
  final chapter = chapters[at];
  return (
    title: _chapterTitle(chapter),
    position: at + 1,
    count: chapters.length,
  );
}

/// A chapter's name, worded the same way the lock screen words it.
String _chapterTitle(MobileAudiobookChapter chapter) =>
    chapter.title.trim().isEmpty ? 'Chapter ${chapter.index}' : chapter.title;

/// Cover, title, chapter and narrator.
///
/// [compact] is a strip for when the transcript is open, because then the words
/// matter more than the artwork; [large] is the cover layout, where the artwork
/// breathes while there is sound and holds still when there is not.
class _NowPlayingHeader extends StatelessWidget {
  const _NowPlayingHeader.compact({
    required this.state,
    required this.bookTitle,
    required this.bookId,
    required this.authorName,
    required this.coverImage,
    required this.onChapters,
  }) : large = false,
       maxHeight = 0;

  const _NowPlayingHeader.large({
    required this.state,
    required this.bookTitle,
    required this.bookId,
    required this.authorName,
    required this.coverImage,
    required this.onChapters,
    required this.maxHeight,
  }) : large = true;

  final AudiobookState state;
  final String bookTitle;
  final String bookId;
  final String? authorName;
  final MobileProjectImage? coverImage;
  final VoidCallback onChapters;
  final bool large;

  /// Room the large layout has, so the cover can give way before the page has
  /// to scroll.
  final double maxHeight;

  @override
  Widget build(BuildContext context) {
    final audiobook = state.audiobook!;
    final chapter = _currentChapterOf(state);
    return large
        ? _buildLarge(context, audiobook, chapter)
        : _buildCompact(context, audiobook, chapter);
  }

  Widget _cover(double width) => BookCover(
    title: bookTitle,
    seed: bookId,
    image: coverImage,
    authorName: authorName,
    width: width,
    borderRadius: width > 100 ? AppRadii.control : AppRadii.compact,
  );

  Widget _buildCompact(
    BuildContext context,
    MobileAudiobook audiobook,
    ({String title, int position, int count})? chapter,
  ) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(20, 6, 12, 10),
      child: Row(
        children: [
          _cover(48),
          const SizedBox(width: 14),
          Expanded(
            child: _ChapterTapTarget(
              onTap: onChapters,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    bookTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  if (chapter != null)
                    _ChapterLine(
                      chapter: chapter,
                      playing: state.playing,
                      compact: true,
                    ),
                  _NarratorLine(audiobook: audiobook, compact: true),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLarge(
    BuildContext context,
    MobileAudiobook audiobook,
    ({String title, int position, int count})? chapter,
  ) {
    final theme = Theme.of(context);
    final scale = _textScaleOf(context);
    final width = MediaQuery.sizeOf(context).width;
    // The text under the cover scales with the reader's settings, so the cover
    // is what gives way.
    final textRoom = 132 * scale;
    final byHeight = (maxHeight - textRoom - 32) / 1.5;
    final coverWidth = math.max(
      88.0,
      math.min(math.min(228.0, width * 0.6), byHeight),
    );

    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(28, 12, 28, 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _BreathingCover(active: state.playing, child: _cover(coverWidth)),
          SizedBox(height: coverWidth > 120 ? 24 : 14),
          Text(
            bookTitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          if (chapter != null)
            _ChapterTapTarget(
              onTap: onChapters,
              child: _ChapterLine(
                chapter: chapter,
                playing: state.playing,
                compact: false,
              ),
            ),
          _NarratorLine(audiobook: audiobook, compact: false),
        ],
      ),
    );
  }
}

/// Makes a block of labels a button that opens the chapter list, with a
/// touch target that does not depend on how short the text is.
class _ChapterTapTarget extends StatelessWidget {
  const _ChapterTapTarget({required this.onTap, required this.child});

  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      hint: 'Shows the chapter list',
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadii.compact),
        onTap: () {
          AppHaptics.selection();
          onTap();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: AppSizes.minimumTouchTarget,
          ),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: child,
          ),
        ),
      ),
    );
  }
}

/// "Low Tide · 2 of 8", with sound bars in front of it while there is sound.
///
/// A live region, so a screen reader hears the chapter change without having to
/// go looking for it.
class _ChapterLine extends StatelessWidget {
  const _ChapterLine({
    required this.chapter,
    required this.playing,
    required this.compact,
  });

  final ({String title, int position, int count}) chapter;
  final bool playing;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style =
        (compact ? theme.textTheme.bodyMedium : theme.textTheme.titleSmall)
            ?.copyWith(fontWeight: FontWeight.w700, color: colors.primary);
    final where = chapter.count > 1
        ? ' · ${chapter.position} of ${chapter.count}'
        : '';
    return Semantics(
      liveRegion: true,
      label:
          'Now playing ${chapter.title}'
          '${chapter.count > 1 ? ', chapter ${chapter.position} of ${chapter.count}' : ''}',
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            AudioSoundBars(
              active: playing,
              color: colors.primary,
              size: compact ? 14 : 16,
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: chapter.title),
                    if (where.isNotEmpty)
                      TextSpan(
                        text: where,
                        style: TextStyle(
                          fontWeight: FontWeight.w500,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
                maxLines: compact ? 1 : 2,
                overflow: TextOverflow.ellipsis,
                textAlign: compact ? TextAlign.start : TextAlign.center,
                style: style,
              ),
            ),
            const SizedBox(width: 2),
            Icon(
              Icons.expand_more_rounded,
              size: compact ? 18 : 20,
              color: colors.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

class _NarratorLine extends StatelessWidget {
  const _NarratorLine({required this.audiobook, required this.compact});

  final MobileAudiobook audiobook;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = theme.textTheme.bodySmall?.copyWith(
      color: colors.onSurfaceVariant,
    );
    return Padding(
      padding: EdgeInsets.only(top: compact ? 0 : 2),
      child: Wrap(
        alignment: compact ? WrapAlignment.start : WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Text(
            'Narrated by ${audiobook.narratorName}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
          if (audiobook.backupNarrationUsed)
            Text(
              'Generated with backup narration',
              style: theme.textTheme.labelSmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}

/// The cover, gently swelling while there is sound and still when there is
/// not.
///
/// Held to a two-and-a-half percent swell on a slow cycle: enough to read as
/// "this is alive" from across a room, not enough to pull the eye off the
/// chapter title. It stops outright for reduced motion, and it never runs while
/// paused, so a screen left open does not spend the battery on decoration.
class _BreathingCover extends StatefulWidget {
  const _BreathingCover({required this.active, required this.child});

  final bool active;
  final Widget child;

  @override
  State<_BreathingCover> createState() => _BreathingCoverState();
}

class _BreathingCoverState extends State<_BreathingCover>
    with SingleTickerProviderStateMixin {
  late final AnimationController _swell = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 3200),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(covariant _BreathingCover oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    final run = widget.active && !AppMotion.reducedMotion(context);
    if (run && !_swell.isAnimating) {
      _swell.repeat(reverse: true);
    } else if (!run && _swell.isAnimating) {
      _swell.stop();
      _swell.animateBack(0, duration: AppMotion.medium);
    }
  }

  @override
  void dispose() {
    _swell.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: _swell,
      child: widget.child,
      builder: (context, child) {
        final t = Curves.easeInOut.transform(_swell.value);
        return DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadii.control),
            boxShadow: [
              BoxShadow(
                color: colors.primary.withValues(alpha: 0.10 + 0.14 * t),
                blurRadius: 28 + 22 * t,
                spreadRadius: 1 + 3 * t,
              ),
            ],
          ),
          child: Transform.scale(scale: 1 + 0.025 * t, child: child),
        );
      },
    );
  }
}
