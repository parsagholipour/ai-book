part of 'creation_chat_screen.dart';

// The frame every chat message is drawn in: the bubble, its avatar, the run it
// belongs to, its time and the day it opened. Both stages of the screen (the
// brainstorm and the finished-book chat) draw their messages through it, which
// is what keeps the two transcripts reading as one conversation. Imports and
// shared state live in the parent library file.

/// Where one message sits in a run of same-speaker messages.
///
/// A run reads as one turn: the bubbles sit close, only the first carries the
/// speaker's avatar and only the last carries the time. Two people typing
/// "hello" and "one more thing" a second apart said one thing in two breaths.
@immutable
class _BubblePlacement {
  const _BubblePlacement({this.first = true, this.last = true, this.dayStart});

  final bool first;
  final bool last;

  /// Set on the message that opens a calendar day; the bubble draws the day's
  /// label above itself. Null when the day is unknown or has not changed.
  final DateTime? dayStart;

  static const alone = _BubblePlacement();
}

/// One transcript entry as far as grouping cares: who said it and when.
/// [isUser] is null for something that is not a message (a plan card, an
/// operation), which ends a run on both sides.
typedef _RunEntry = ({bool? isUser, DateTime? at});

/// Messages from the same speaker this close together are one run.
const _runGap = Duration(minutes: 5);

bool _sameDay(DateTime a, DateTime b) {
  final left = a.toLocal();
  final right = b.toLocal();
  return left.year == right.year &&
      left.month == right.month &&
      left.day == right.day;
}

bool _joinsRun(_RunEntry a, _RunEntry b) {
  if (a.isUser == null || b.isUser == null || a.isUser != b.isUser) {
    return false;
  }
  final earlier = a.at;
  final later = b.at;
  // Without both times the speaker is all there is to go on.
  if (earlier == null || later == null) return true;
  return _sameDay(earlier, later) && later.difference(earlier).abs() <= _runGap;
}

_BubblePlacement _placementAt(List<_RunEntry> entries, int index) {
  if (index < 0 || index >= entries.length) return _BubblePlacement.alone;
  final entry = entries[index];
  final previous = index > 0 ? entries[index - 1] : null;
  final next = index + 1 < entries.length ? entries[index + 1] : null;
  final at = entry.at;
  final previousAt = previous?.at;
  final opensDay =
      at != null &&
      (previous == null || (previousAt != null && !_sameDay(previousAt, at)));
  return _BubblePlacement(
    first: previous == null || !_joinsRun(previous, entry),
    last: next == null || !_joinsRun(entry, next),
    dayStart: opensDay ? at : null,
  );
}

/// The time of a message in the reader's own clock format (12 or 24 hour).
String _chatTimeLabel(BuildContext context, DateTime value) {
  return MaterialLocalizations.of(context).formatTimeOfDay(
    TimeOfDay.fromDateTime(value.toLocal()),
    alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
  );
}

String _chatDayLabel(BuildContext context, DateTime value) {
  final now = DateTime.now();
  if (_sameDay(value, now)) return 'Today';
  if (_sameDay(value, now.subtract(const Duration(days: 1)))) {
    return 'Yesterday';
  }
  return MaterialLocalizations.of(context).formatMediumDate(value.toLocal());
}

class _DaySeparator extends StatelessWidget {
  const _DaySeparator({required this.day});

  final DateTime day;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 6),
      child: Center(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Text(
              _chatDayLabel(context, day),
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// How much of the row the assistant's avatar and its gap take.
const _avatarSlot = ChatAssistantAvatar.slot;

/// One message's bubble, placed in its run.
///
/// The speakers differ by side, by tone and by avatar — never by the primary
/// button fill, which belongs to controls: [background] for a sent message is
/// `userChatBubbleColors`, a wash of the same hue.
class _ChatBubbleShell extends StatelessWidget {
  const _ChatBubbleShell({
    required this.isUser,
    required this.background,
    required this.child,
    this.placement = _BubblePlacement.alone,
    this.timestamp,
    this.onLongPressStart,
  });

  final bool isUser;
  final Color background;
  final Widget child;
  final _BubblePlacement placement;

  /// Drawn under the bubble on the last message of a run.
  final String? timestamp;
  final Future<void> Function(LongPressStartDetails details)? onLongPressStart;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    const round = Radius.circular(18);
    const joined = Radius.circular(5);
    const tail = Radius.circular(4);
    final speakerTop = placement.first ? round : joined;
    final speakerBottom = placement.last ? tail : joined;
    final radius = isUser
        ? BorderRadiusDirectional.only(
            topStart: round,
            bottomStart: round,
            topEnd: speakerTop,
            bottomEnd: speakerBottom,
          )
        : BorderRadiusDirectional.only(
            topEnd: round,
            bottomEnd: round,
            topStart: speakerTop,
            bottomStart: speakerBottom,
          );
    final width = MediaQuery.sizeOf(context).width;
    final bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      constraints: BoxConstraints(maxWidth: width * (isUser ? 0.82 : 0.8)),
      decoration: BoxDecoration(color: background, borderRadius: radius),
      child: child,
    );
    final framed = onLongPressStart == null
        ? bubble
        : MessageHoldFeedback(
            onLongPressStart: onLongPressStart!,
            child: bubble,
          );
    final column = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: isUser
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.start,
      children: [
        framed,
        if (placement.last && timestamp != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(top: 3, start: 4, end: 4),
            child: Text(
              timestamp!,
              style: theme.textTheme.labelSmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
    return Padding(
      padding: EdgeInsets.only(
        top: placement.first ? 6 : 2,
        bottom: placement.last ? 6 : 0,
      ),
      child: Align(
        alignment: isUser
            ? AlignmentDirectional.centerEnd
            : AlignmentDirectional.centerStart,
        child: isUser
            ? column
            : Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (placement.first)
                    const Padding(
                      padding: EdgeInsetsDirectional.only(end: 8),
                      child: ChatAssistantAvatar(),
                    )
                  else
                    const SizedBox(width: _avatarSlot),
                  Flexible(child: column),
                ],
              ),
      ),
    );
  }
}
