export 'generation_finished_card.dart'
    show GenerationFinishedCard, finishedBookSummary;

/// Short, readable elapsed time for completed planning and writing attempts.
String? formatGenerationDuration(int? milliseconds) {
  if (milliseconds == null || milliseconds < 0) return null;
  final seconds = (milliseconds / 1000).round();
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  final remainder = seconds % 60;
  if (minutes < 60) {
    return remainder == 0 ? '${minutes}m' : '${minutes}m ${remainder}s';
  }
  final hours = minutes ~/ 60;
  final remainingMinutes = minutes % 60;
  return '${hours}h ${remainingMinutes}m';
}

/// The time-left line under a plan's or a book's progress, from the seconds
/// the server estimated (and this phone has counted down since). Rounded up to
/// whole minutes, like [formatRetryCountdown], so it never promises sooner than
/// the server did; once the count has run out with the work still going, it
/// says so without a number.
String formatTimeLeft(int seconds) {
  if (seconds <= 0) return 'Almost done';
  if (seconds < 60) return 'Less than a minute left';
  return 'About ${(seconds / 60).ceil()} min left';
}

/// When an automatic retry will run, in words: the server's own `nextRetryAt`
/// against [now]. Rounded up to whole minutes so it never promises sooner than
/// it will happen, and it says so plainly once the moment has arrived.
String formatRetryCountdown(DateTime? nextRetryAt, DateTime now) {
  if (nextRetryAt == null) return 'Trying again shortly.';
  final seconds = nextRetryAt.difference(now).inSeconds;
  if (seconds <= 5) return 'Trying again now.';
  if (seconds < 60) return 'Trying again in under a minute.';
  final minutes = (seconds / 60).ceil();
  if (minutes < 60) return 'Trying again in about $minutes min.';
  final hours = (minutes / 60).ceil();
  return 'Trying again in about $hours h.';
}
