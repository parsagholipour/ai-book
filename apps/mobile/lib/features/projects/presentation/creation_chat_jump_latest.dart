part of 'creation_chat_screen.dart';

// The way back down. A reader who scrolls up to reread something stops being
// carried along by new messages (that is what `_stickToBottom` means), so the
// conversation can move on without them noticing; this says so, counts what they
// missed, and takes them back in one tap. Imports and shared state live in the
// parent library file.

class _JumpToLatestButton extends StatefulWidget {
  const _JumpToLatestButton({
    required this.controller,
    required this.itemCount,
    required this.onPressed,
  });

  final ScrollController controller;

  /// How many messages the transcript holds. Growth while the reader is away is
  /// what the badge counts; the typing indicator is deliberately not one.
  final int itemCount;
  final VoidCallback onPressed;

  @override
  State<_JumpToLatestButton> createState() => _JumpToLatestButtonState();
}

class _JumpToLatestButtonState extends State<_JumpToLatestButton> {
  /// How far above the newest message counts as "away". More than a bubble
  /// about, so a small drag while reading does not summon the button.
  static const _awayExtent = 160.0;

  bool _away = false;

  /// The message count when the reader left the bottom.
  int _baseline = 0;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void didUpdateWidget(covariant _JumpToLatestButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_sync);
      widget.controller.addListener(_sync);
    }
    // New content moves the bottom away without any scrolling happening, so the
    // scroll listener alone would never see it.
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void dispose() {
    widget.controller.removeListener(_sync);
    super.dispose();
  }

  void _sync() {
    if (!mounted || !widget.controller.hasClients) return;
    final away = widget.controller.position.extentAfter > _awayExtent;
    if (away == _away) return;
    setState(() {
      _away = away;
      if (away) _baseline = widget.itemCount;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final unread = _away ? math.max(0, widget.itemCount - _baseline) : 0;
    final label = unread > 0
        ? (unread == 1 ? '1 new message' : '$unread new messages')
        : 'Jump to latest';
    final motion = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.fast;
    return IgnorePointer(
      ignoring: !_away,
      child: ExcludeSemantics(
        excluding: !_away,
        child: AnimatedSlide(
          duration: motion,
          curve: AppMotion.enter,
          offset: _away ? Offset.zero : const Offset(0, 0.6),
          child: AnimatedOpacity(
            duration: motion,
            opacity: _away ? 1 : 0,
            child: Semantics(
              button: true,
              label: label,
              child: ExcludeSemantics(
                child: Material(
                  color: unread > 0
                      ? colors.primaryContainer
                      : colors.surfaceContainerHighest,
                  elevation: 3,
                  shadowColor: colors.shadow.withValues(alpha: 0.35),
                  shape: const StadiumBorder(),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () {
                      AppHaptics.tap();
                      widget.onPressed();
                    },
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        minHeight: 40,
                        minWidth: 40,
                      ),
                      child: Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: unread > 0 ? 14 : 8,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.arrow_downward_rounded,
                              size: 20,
                              color: unread > 0
                                  ? colors.onPrimaryContainer
                                  : colors.onSurfaceVariant,
                            ),
                            if (unread > 0) ...[
                              const SizedBox(width: 6),
                              Text(
                                '$unread new',
                                style: Theme.of(context).textTheme.labelLarge
                                    ?.copyWith(
                                      color: colors.onPrimaryContainer,
                                      fontWeight: FontWeight.w700,
                                    ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
