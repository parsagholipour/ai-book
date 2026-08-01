part of 'audiobook_screen.dart';

/// The words, following the voice.
///
/// The sentence being spoken is highlighted and kept on screen, and any sentence
/// can be tapped to jump there. Auto-scroll yields the moment the reader drags —
/// someone looking back at an earlier paragraph should not be yanked forward
/// every few seconds — and resumes only when they return to the current line.
class _TranscriptPane extends ConsumerStatefulWidget {
  const _TranscriptPane({
    required this.projectId,
    required this.timeline,
    required this.activeSegmentIndex,
  });

  final String projectId;
  final AudiobookChapterTimeline? timeline;
  final int? activeSegmentIndex;

  @override
  ConsumerState<_TranscriptPane> createState() => _TranscriptPaneState();
}

class _TranscriptPaneState extends ConsumerState<_TranscriptPane> {
  final ScrollController _scroll = ScrollController();
  final Map<int, GlobalKey> _paragraphKeys = {};
  bool _following = true;
  bool _userDragging = false;
  int? _lastFollowedSegment;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(_TranscriptPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.timeline?.chapterIndex != oldWidget.timeline?.chapterIndex) {
      // A new chapter restarts the transcript, so following resumes even if the
      // reader had scrolled away in the previous one.
      _paragraphKeys.clear();
      _following = true;
      _lastFollowedSegment = null;
    }
    if (widget.activeSegmentIndex != oldWidget.activeSegmentIndex) {
      _scheduleFollow();
    }
  }

  void _scheduleFollow() {
    final active = widget.activeSegmentIndex;
    if (!_following || _userDragging || active == null || active == _lastFollowedSegment) {
      return;
    }
    _lastFollowedSegment = active;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_following || _userDragging) {
        return;
      }
      final timeline = widget.timeline;
      if (timeline == null) {
        return;
      }
      final segment = timeline.segments.firstWhere(
        (entry) => entry.index == active,
        orElse: () => timeline.segments.first,
      );
      final key = _paragraphKeys[segment.paragraph];
      final target = key?.currentContext;
      if (target == null) {
        return;
      }
      Scrollable.ensureVisible(
        target,
        alignment: 0.35,
        duration: AppMotion.reducedMotion(context) ? Duration.zero : AppMotion.slow,
        curve: AppMotion.standard,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final timeline = widget.timeline;

    if (timeline == null) {
      return const AppLoadingState(message: 'Loading the transcript');
    }

    final paragraphs = paragraphsOf(timeline);
    final controller = ref.read(audiobookControllerProvider(widget.projectId).notifier);

    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification is ScrollStartNotification && notification.dragDetails != null) {
          _userDragging = true;
          setState(() => _following = false);
        } else if (notification is ScrollEndNotification) {
          _userDragging = false;
        }
        return false;
      },
      child: Stack(
        children: [
          // Fades the top edge so text slides out of view rather than being cut.
          ShaderMask(
            shaderCallback: (bounds) => const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Colors.transparent, Colors.black, Colors.black],
              stops: [0, 0.06, 1],
            ).createShader(bounds),
            blendMode: BlendMode.dstIn,
            child: Directionality(
              // Books are written in the reader's language, and some of them run
              // right to left.
              textDirection: timeline.isRightToLeft ? TextDirection.rtl : TextDirection.ltr,
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
                itemCount: paragraphs.length,
                itemBuilder: (context, index) {
                  final paragraph = paragraphs[index];
                  final paragraphNumber = paragraph.first.paragraph;
                  final key = _paragraphKeys.putIfAbsent(paragraphNumber, GlobalKey.new);
                  return Padding(
                    key: key,
                    padding: const EdgeInsets.only(bottom: 16),
                    child: _TranscriptParagraph(
                      segments: paragraph,
                      activeSegmentIndex: widget.activeSegmentIndex,
                      onTapSegment: controller.seekToSegment,
                    ),
                  );
                },
              ),
            ),
          ),
          if (!_following)
            Positioned(
              right: 16,
              bottom: 16,
              child: FloatingActionButton.small(
                heroTag: 'transcript-resume',
                backgroundColor: colors.primary,
                foregroundColor: colors.onPrimary,
                onPressed: () {
                  AppHaptics.tap();
                  setState(() {
                    _following = true;
                    _lastFollowedSegment = null;
                  });
                  _scheduleFollow();
                },
                child: const Icon(Icons.vertical_align_center),
              ),
            ),
        ],
      ),
    );
  }
}

class _TranscriptParagraph extends StatelessWidget {
  const _TranscriptParagraph({
    required this.segments,
    required this.activeSegmentIndex,
    required this.onTapSegment,
  });

  final List<AudiobookSegment> segments;
  final int? activeSegmentIndex;
  final void Function(AudiobookSegment segment) onTapSegment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final isTitle = segments.first.isTitle;

    final base = (isTitle ? theme.textTheme.titleMedium : theme.textTheme.bodyLarge)?.copyWith(
      height: isTitle ? 1.3 : 1.62,
      fontWeight: isTitle ? FontWeight.w800 : FontWeight.w400,
      color: colors.onSurfaceVariant,
    );

    return Text.rich(
      TextSpan(
        children: [
          for (final (position, segment) in segments.indexed) ...[
            if (position > 0) const TextSpan(text: ' '),
            TextSpan(
              text: segment.text,
              style: segment.index == activeSegmentIndex
                  ? base?.copyWith(
                      color: colors.onSurface,
                      backgroundColor: colors.primary.withValues(alpha: 0.16),
                      fontWeight: isTitle ? FontWeight.w800 : FontWeight.w600,
                    )
                  : base,
              recognizer: TapGestureRecognizer()..onTap = () {
                AppHaptics.selection();
                onTapSegment(segment);
              },
            ),
          ],
        ],
      ),
    );
  }
}
