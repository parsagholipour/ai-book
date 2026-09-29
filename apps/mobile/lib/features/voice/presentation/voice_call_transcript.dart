part of 'voice_call_screen.dart';

class _CallTranscript extends StatefulWidget {
  const _CallTranscript({required this.state});

  final VoiceCallState state;

  @override
  State<_CallTranscript> createState() => _CallTranscriptState();
}

/// Keeps the newest line in view without ever taking the scroll away from the
/// reader.
///
/// Following the bottom of a feed that is being written to several times a
/// second is fiddlier than it looks, and each rule below is here because its
/// absence was visible:
///
/// * React to new *text*, not to rebuilds. The call timer ticks every second,
///   which rebuilds this widget; scrolling on that kicked the transcript once
///   a second through silence.
/// * Never stack animations. Transcription arrives as a stream of deltas, and
///   starting a fresh `animateTo` over a running one interrupts it — repeated
///   interruption is what read as stutter. A scroll asked for mid-flight is
///   remembered and run once the current one lands.
/// * Stop following the moment the reader scrolls away, and resume only when
///   they come back to the bottom themselves.
/// * Re-measure after every frame. The live caption grows as it is spoken, so
///   the extent captured when a scroll was scheduled is already short by the
///   time it runs.
class _CallTranscriptState extends State<_CallTranscript> {
  /// How close to the end still counts as "at the bottom", in logical pixels.
  static const _bottomSlack = 24.0;

  final _scrollController = ScrollController();

  /// Whether new lines should pull the view down. Off while the reader is
  /// looking at something further up.
  bool _following = true;
  bool _animating = false;
  bool _followQueued = false;
  bool _framePending = false;
  bool _userDragging = false;

  /// Whether anything has scrolled off the top yet. The fade is only drawn
  /// when there is something above to fade, so the first line of a short
  /// transcript is not rendered half-transparent.
  bool _contentAbove = false;

  @override
  void initState() {
    super.initState();
    // A transcript that already has lines when this mounts — a rebuilt screen,
    // a hot reload — should open at the newest line, not at the top of the
    // conversation.
    _scheduleFollow();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(_CallTranscript oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_transcriptChanged(oldWidget.state, widget.state)) {
      _scheduleFollow();
    }
  }

  /// Whether there is new text, as opposed to any other reason to rebuild.
  ///
  /// `captions` keeps its identity across a `copyWith` that did not touch it,
  /// so an identity check is both cheap and exact.
  static bool _transcriptChanged(VoiceCallState before, VoiceCallState after) {
    return !identical(before.captions, after.captions) ||
        !identical(before.liveCaptions, after.liveCaptions);
  }

  void _scheduleFollow() {
    if (!_following || _framePending) return;
    _framePending = true;
    // After the frame, so the line that triggered this has been laid out and
    // the extent we scroll to is the real one.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _framePending = false;
      _followBottom();
    });
  }

  void _followBottom() {
    if (!mounted || !_following || !_scrollController.hasClients) {
      _followQueued = false;
      return;
    }
    if (_animating) {
      // Land the current scroll first, then come back for whatever arrived.
      _followQueued = true;
      return;
    }

    final position = _scrollController.position;
    final target = position.maxScrollExtent;
    _followQueued = false;
    if ((target - position.pixels).abs() < 0.5) {
      return;
    }
    if (AppMotion.reducedMotion(context)) {
      _scrollController.jumpTo(target);
      // Lines below the fold are only estimated until they have been built, so
      // the end that was just reached may not be the end. Look once more next
      // frame; it costs nothing when the estimate was right.
      _scheduleFollow();
      return;
    }

    _animating = true;
    _scrollController
        .animateTo(target, duration: AppMotion.fast, curve: AppMotion.standard)
        .whenComplete(() {
          _animating = false;
          if (mounted && _followQueued) {
            _followBottom();
          } else {
            _scheduleFollow();
          }
        });
  }

  /// Hands control to the reader as soon as they touch the list, and takes it
  /// back only when they leave it at the bottom.
  bool _onScroll(ScrollNotification notification) {
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      _userDragging = true;
      _following = false;
    } else if (notification is ScrollUpdateNotification &&
        notification.dragDetails != null) {
      _following = _isAtBottom(notification.metrics);
    } else if (notification is ScrollEndNotification && _userDragging) {
      // Only a scroll the reader drove decides this. A programmatic scroll can
      // end short of the bottom when a line landed mid-flight, and reading that
      // as "they scrolled away" would stop the transcript following for good.
      _userDragging = false;
      _following = _isAtBottom(notification.metrics);
      if (_following) {
        _scheduleFollow();
      }
    }

    final contentAbove = notification.metrics.pixels > 0.5;
    if (contentAbove != _contentAbove && mounted) {
      setState(() => _contentAbove = contentAbove);
    }
    return false;
  }

  static bool _isAtBottom(ScrollMetrics metrics) {
    return metrics.pixels >= metrics.maxScrollExtent - _bottomSlack;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final lines = [...widget.state.captions, ...widget.state.liveCaptions];
    if (lines.isEmpty) {
      // A quiet line is the moment someone wonders whether it is working.
      if (!widget.state.isLive) {
        return const SizedBox.shrink();
      }
      return Align(
        alignment: Alignment.topCenter,
        child: Text(
          widget.state.muted
              ? 'You are muted. Tap the microphone to talk.'
              : 'Say hello — they can hear you. Captions appear here.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      );
    }
    final sent = userChatBubbleColors(colors);

    final list = NotificationListener<ScrollNotification>(
      onNotification: _onScroll,
      child: ListView.builder(
        controller: _scrollController,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: lines.length,
        itemBuilder: (context, index) {
          final caption = lines[index];
          final fromCaller = caption.speaker == VoiceCallSpeaker.caller;
          final text = Text(
            caption.text,
            textAlign: fromCaller ? TextAlign.end : TextAlign.start,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: fromCaller ? sent.foreground : colors.onSurface,
              height: 1.35,
            ),
          );
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Align(
              alignment: fromCaller
                  ? AlignmentDirectional.centerEnd
                  : AlignmentDirectional.centerStart,
              child: Semantics(
                label: fromCaller ? 'You: ${caption.text}' : caption.text,
                child: ExcludeSemantics(
                  // The caller's own words sit in a soft bubble on their side;
                  // the character's are plain type on the other, so who said a
                  // line reads before it is read.
                  child: fromCaller
                      ? Container(
                          constraints: BoxConstraints(
                            maxWidth: MediaQuery.sizeOf(context).width * 0.78,
                          ),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 9,
                          ),
                          decoration: BoxDecoration(
                            color: sent.background,
                            borderRadius: BorderRadius.circular(AppRadii.card),
                          ),
                          child: text,
                        )
                      : text,
                ),
              ),
            ),
          );
        },
      ),
    );

    // The mask is always in the tree, and only its gradient changes. Adding or
    // removing a parent widget here instead would remount the list on the first
    // scroll and throw the reader's position away.
    return ShaderMask(
      // Fades lines out as they leave the top rather than clipping them, so
      // older text recedes instead of being chopped mid-word. Collapsed to a
      // no-op until something has actually scrolled off, so the opening line of
      // a short transcript is not rendered half-transparent for no reason.
      shaderCallback: (bounds) => LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: const [Colors.transparent, Colors.black, Colors.black],
        stops: _contentAbove ? const [0, 0.18, 1] : const [0, 0, 1],
      ).createShader(bounds),
      blendMode: BlendMode.dstIn,
      child: list,
    );
  }
}
