part of 'audiobook_screen.dart';

/// How far down the viewport a followed sentence lands.
const double _followAlignment = 0.35;

/// The ceiling on hops a single follow may take. Each hop builds the rows
/// around its guess, which sharpens the guess after it, so a paragraph anywhere
/// in a chapter is normally reached in two or three.
const int _maxFollowHops = 6;

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
    this.showHint = false,
  });

  final String projectId;
  final AudiobookChapterTimeline? timeline;
  final int? activeSegmentIndex;

  /// Says that a sentence can be tapped, until the listener has pressed play:
  /// the feature is invisible otherwise, and it is the best thing on the page.
  final bool showHint;

  @override
  ConsumerState<_TranscriptPane> createState() => _TranscriptPaneState();
}

class _TranscriptPaneState extends ConsumerState<_TranscriptPane> {
  final ScrollController _scroll = ScrollController();

  /// Keyed by row, not by `AudiobookSegment.paragraph`: a paragraph number can
  /// legitimately open a second run of segments, and two rows sharing one
  /// GlobalKey is a crash rather than a mis-scroll.
  final Map<int, GlobalKey> _paragraphKeys = {};

  /// The rows, and which row each sentence sits in. Both are rebuilt when the
  /// chapter changes rather than on every position tick.
  List<List<AudiobookSegment>> _paragraphs = const [];
  final Map<int, int> _rowOfSegment = {};

  bool _following = true;

  /// A finger is on the list *right now* — which is not the same as the list
  /// moving. A fling coasts long after the hand has left, and refusing to
  /// follow during it is refusing the reader who just asked.
  bool _userDragging = false;
  int? _lastFollowedSegment;

  /// Bumped by every follow, so one that is parked on a frame boundary notices
  /// it has been superseded instead of scrolling on top of its successor.
  int _followGeneration = 0;

  @override
  void initState() {
    super.initState();
    _indexParagraphs();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(_TranscriptPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(widget.timeline, oldWidget.timeline)) {
      _indexParagraphs();
    }
    if (widget.timeline?.chapterIndex != oldWidget.timeline?.chapterIndex) {
      // A new chapter restarts the transcript, so following resumes even if the
      // reader had scrolled away in the previous one.
      _following = true;
      _lastFollowedSegment = null;
    }
    if (widget.activeSegmentIndex != oldWidget.activeSegmentIndex) {
      _scheduleFollow();
    }
  }

  void _indexParagraphs() {
    final timeline = widget.timeline;
    _paragraphs = timeline == null ? const [] : paragraphsOf(timeline);
    _rowOfSegment.clear();
    for (final (row, paragraph) in _paragraphs.indexed) {
      for (final segment in paragraph) {
        _rowOfSegment[segment.index] = row;
      }
    }
    _paragraphKeys.clear();
  }

  void _scheduleFollow() {
    final active = widget.activeSegmentIndex;
    if (!_following ||
        _userDragging ||
        active == null ||
        active == _lastFollowedSegment) {
      return;
    }
    _lastFollowedSegment = active;
    _followSegment(active);
  }

  /// Brings the sentence being spoken back on screen.
  ///
  /// Its paragraph is often not built. A lazy list only mounts what is near the
  /// viewport, so after a seek — or after the reader scrolled a chapter away —
  /// there is no context for `ensureVisible` to work with, which is why asking
  /// for it alone did nothing at all: the further the jump, the more certain it
  /// was to be ignored. So each hop moves to where the rows that *are* built say
  /// the paragraph should be; that builds the rows around the guess, which
  /// sharpens the next one, until the paragraph itself is mounted and can be
  /// revealed exactly.
  Future<void> _followSegment(int segmentIndex) async {
    final generation = ++_followGeneration;
    final row = _rowOfSegment[segmentIndex];
    if (row == null) {
      return;
    }
    // Read before the first frame is awaited: afterwards this context has been
    // through an async gap and is no longer safe to reach into.
    final reveal = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.slow;

    for (var hop = 0; hop < _maxFollowHops; hop += 1) {
      // The keys are only as good as the frame that built them, and the first
      // hop is dispatched from didUpdateWidget — before this frame has laid
      // anything out.
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) {
        return;
      }
      if (generation != _followGeneration ||
          !_following ||
          _userDragging ||
          !_scroll.hasClients) {
        return;
      }

      // `mounted` on the row's own context, not on this State: the paragraph is
      // what the scroll is about to reach into, and a lazy list unmounts rows
      // between frames.
      final target = _paragraphKeys[row]?.currentContext;
      if (target != null && target.mounted) {
        await Scrollable.ensureVisible(
          target,
          alignment: _followAlignment,
          duration: reveal,
          curve: AppMotion.standard,
        );
        return;
      }

      final guess = _guessOffsetOfRow(row);
      if (guess == null) {
        return;
      }
      final position = _scroll.position;
      final hopTo = guess.clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if ((hopTo - position.pixels).abs() < 1) {
        // Already where the list believes the row is; another hop would land in
        // the same place and only cost a frame.
        return;
      }
      _scroll.jumpTo(hopTo);
    }
  }

  /// Where row [row] probably starts, extrapolated from the rows built right
  /// now. Null when there is nothing built to extrapolate from.
  double? _guessOffsetOfRow(int row) {
    final known = <int, ({double offset, double extent})>{};
    for (final entry in _paragraphKeys.entries) {
      final box = entry.value.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) {
        continue;
      }
      final viewport = RenderAbstractViewport.maybeOf(box);
      if (viewport == null) {
        continue;
      }
      known[entry.key] = (
        offset: viewport.getOffsetToReveal(box, 0).offset,
        extent: box.size.height,
      );
    }
    if (known.isEmpty) {
      return null;
    }

    final rows = known.keys.toList()..sort();
    final first = rows.first;
    final last = rows.last;
    // Two built rows give the real average — gaps between them included. One
    // gives only its own height, which is the best that can be said.
    final averageExtent = last > first
        ? (known[last]!.offset - known[first]!.offset) / (last - first)
        : known[first]!.extent;
    // Anchoring on the nearest built row keeps the error proportional to the
    // distance left, so successive hops close in rather than orbit.
    final anchor = rows.reduce(
      (a, b) => (a - row).abs() <= (b - row).abs() ? a : b,
    );
    return known[anchor]!.offset + (row - anchor) * averageExtent;
  }

  @override
  Widget build(BuildContext context) {
    final timeline = widget.timeline;

    if (timeline == null) {
      return const _TranscriptSkeleton();
    }

    final controller = ref.read(
      audiobookControllerProvider(widget.projectId).notifier,
    );

    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification is ScrollStartNotification) {
          if (notification.dragDetails != null) {
            _userDragging = true;
            setState(() => _following = false);
          }
        } else if (notification is ScrollUpdateNotification) {
          // Only a drag carries details, and a drag handing off to a fling
          // dispatches no end notification — both activities count as
          // scrolling — so this is the one place the finger lifting is
          // reported at all.
          _userDragging = notification.dragDetails != null;
        } else if (notification is ScrollEndNotification) {
          _userDragging = false;
        }
        return false;
      },
      child: Column(
        children: [
          AppSwitcher(
            child: widget.showHint
                ? const _TranscriptHint(key: ValueKey('hint'))
                : const SizedBox(
                    key: ValueKey('no-hint'),
                    width: double.infinity,
                  ),
          ),
          Expanded(
            child: Stack(
              children: [
                // Fades the top edge so text slides out of view rather than
                // being cut.
                ShaderMask(
                  shaderCallback: (bounds) => const LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Colors.black, Colors.black],
                    stops: [0, 0.06, 1],
                  ).createShader(bounds),
                  blendMode: BlendMode.dstIn,
                  child: Directionality(
                    // Books are written in the reader's language, and some of
                    // them run right to left.
                    textDirection: timeline.isRightToLeft
                        ? TextDirection.rtl
                        : TextDirection.ltr,
                    child: ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(22, 8, 22, 88),
                      itemCount: _paragraphs.length,
                      itemBuilder: (context, index) {
                        final key = _paragraphKeys.putIfAbsent(
                          index,
                          GlobalKey.new,
                        );
                        return Padding(
                          key: key,
                          padding: const EdgeInsets.only(bottom: 16),
                          child: _TranscriptParagraph(
                            segments: _paragraphs[index],
                            activeSegmentIndex: widget.activeSegmentIndex,
                            onTapSegment: controller.seekToSegment,
                          ),
                        );
                      },
                    ),
                  ),
                ),
                if (!_following)
                  PositionedDirectional(
                    end: 16,
                    bottom: 16,
                    child: AppEntrance(
                      offset: 10,
                      child: _FollowPill(
                        onPressed: () {
                          AppHaptics.tap();
                          // Whatever the list is doing, this tap is the newer
                          // instruction — including a second finger still
                          // dragging it. The first hop's jump takes the scroll
                          // off any momentum it still had.
                          _userDragging = false;
                          setState(() {
                            _following = true;
                            _lastFollowedSegment = null;
                          });
                          _scheduleFollow();
                        },
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The way back to the line being read, named. Shown only once the reader has
/// scrolled away: following is the default, so there is nothing to switch on
/// until it has been switched off.
class _FollowPill extends StatelessWidget {
  const _FollowPill({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: true,
      label: 'Back to the line being read',
      onTap: onPressed,
      child: ExcludeSemantics(
        child: Material(
          color: colors.primary,
          elevation: 3,
          shadowColor: Colors.black54,
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.vertical_align_center,
                      size: 20,
                      color: colors.onPrimary,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      'Follow along',
                      style: theme.textTheme.labelLarge?.copyWith(
                        color: colors.onPrimary,
                        fontWeight: FontWeight.w700,
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

class _TranscriptHint extends StatelessWidget {
  const _TranscriptHint({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 0, 22, 6),
      child: Row(
        children: [
          Icon(Icons.touch_app_outlined, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Tap any sentence to jump there.',
              style: theme.textTheme.labelMedium?.copyWith(color: color),
            ),
          ),
        ],
      ),
    );
  }
}

/// Lines of grey where the words will be, while the chapter's timings arrive.
class _TranscriptSkeleton extends StatelessWidget {
  const _TranscriptSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading the transcript',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final width in const [0.5, 1.0, 0.94, 0.72, 1.0, 0.86])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: FractionallySizedBox(
                      widthFactor: width,
                      child: Container(
                        height: 14,
                        decoration: BoxDecoration(
                          color: colors.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(7),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One paragraph of sentences. Sentences already heard are dimmed, the one being
/// spoken is lit, and the ones to come read at full strength — so the eye has
/// somewhere to rest even when the page is a wall of text.
///
/// The weight never changes between those states: a bolder active sentence is
/// wider, and re-wrapping the paragraph on every sentence is what makes a
/// following transcript feel like it is shaking.
class _TranscriptParagraph extends StatefulWidget {
  const _TranscriptParagraph({
    required this.segments,
    required this.activeSegmentIndex,
    required this.onTapSegment,
  });

  final List<AudiobookSegment> segments;
  final int? activeSegmentIndex;
  final void Function(AudiobookSegment segment) onTapSegment;

  @override
  State<_TranscriptParagraph> createState() => _TranscriptParagraphState();
}

class _TranscriptParagraphState extends State<_TranscriptParagraph> {
  /// Owned here so they can be disposed: a recogniser built inside `build` and
  /// never released is a leak that grows with every position tick.
  final Map<int, TapGestureRecognizer> _taps = {};

  TapGestureRecognizer _tapFor(AudiobookSegment segment) {
    return _taps.putIfAbsent(
      segment.index,
      () => TapGestureRecognizer()
        ..onTap = () {
          AppHaptics.selection();
          widget.onTapSegment(segment);
        },
    );
  }

  void _releaseTaps() {
    for (final recognizer in _taps.values) {
      recognizer.dispose();
    }
    _taps.clear();
  }

  @override
  void didUpdateWidget(covariant _TranscriptParagraph oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Sentence numbers restart with every chapter, so a recogniser kept across
    // a chapter change would seek to the old chapter's sentence of that number.
    if (!identical(oldWidget.segments, widget.segments)) {
      _releaseTaps();
    }
  }

  @override
  void dispose() {
    _releaseTaps();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final segments = widget.segments;
    final active = widget.activeSegmentIndex;
    final isTitle = segments.first.isTitle;

    final base =
        (isTitle ? theme.textTheme.titleMedium : theme.textTheme.bodyLarge)
            ?.copyWith(
              height: isTitle ? 1.3 : 1.62,
              fontWeight: isTitle ? FontWeight.w800 : FontWeight.w400,
            );
    final heard = base?.copyWith(color: colors.onSurfaceVariant);
    final upcoming = base?.copyWith(
      color: colors.onSurface.withValues(alpha: 0.9),
    );
    final speaking = base?.copyWith(
      color: colors.onSurface,
      backgroundColor: colors.primary.withValues(alpha: 0.18),
    );

    return Text.rich(
      TextSpan(
        children: [
          for (final (position, segment) in segments.indexed) ...[
            if (position > 0) const TextSpan(text: ' '),
            TextSpan(
              text: segment.text,
              style: active == null
                  ? upcoming
                  : segment.index == active
                  ? speaking
                  : segment.index < active
                  ? heard
                  : upcoming,
              recognizer: _tapFor(segment),
            ),
          ],
        ],
      ),
    );
  }
}
