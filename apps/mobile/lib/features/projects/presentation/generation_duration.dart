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
