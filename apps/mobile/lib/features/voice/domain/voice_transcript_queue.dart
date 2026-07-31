import 'voice_models.dart';

/// Finished lines waiting to reach the server.
///
/// The call's captions cannot double as the record: they are a display buffer,
/// capped and trimmed from the front while the call is still running, so by the
/// time a long call hangs up its own opening is already gone. This holds every
/// completed line until a request carries it away, and takes a failed batch back
/// so a missed heartbeat costs a delay rather than a memory.
///
/// Uploads are therefore at-least-once. The server drops the overlap when a
/// batch arrives twice, which is the trade that makes a retry safe here.
class VoiceTranscriptQueue {
  /// Lines sent per request. Matches what the API accepts in one body.
  static const batchSize = 60;

  /// Lines held while nothing is getting through. Past this the oldest go: the
  /// server keeps only the tail of a call anyway, and an offline stretch must
  /// not grow without limit in memory.
  static const _capacity = 200;

  /// Longest line the API takes. Truncated here rather than rejected there — a
  /// 400 on the heartbeat would stall the meter and strand the call.
  static const _maxTextLength = 2000;

  final List<VoiceCallCaption> _pending = [];

  bool get isEmpty => _pending.isEmpty;

  void add(VoiceCallCaption line) {
    final text = line.text.trim();
    if (text.isEmpty) return;
    _pending.add(
      line.copyWith(
        text: text.length > _maxTextLength
            ? '${text.substring(0, _maxTextLength - 1)}…'
            : text,
      ),
    );
    if (_pending.length > _capacity) {
      _pending.removeRange(0, _pending.length - _capacity);
    }
  }

  /// Removes and returns the next batch, oldest first.
  List<VoiceCallCaption> take() {
    if (_pending.isEmpty) return const [];
    final count = _pending.length < batchSize ? _pending.length : batchSize;
    final batch = _pending.sublist(0, count);
    _pending.removeRange(0, count);
    return batch;
  }

  /// Empties the queue for a call's last request, keeping the newest lines.
  ///
  /// There is only one request left to spend, and after a run of failed
  /// heartbeats the queue can hold more than one carries. The end of the call
  /// is the part worth keeping — it is also the only part the server stores.
  List<VoiceCallCaption> drain() {
    final start = _pending.length > batchSize ? _pending.length - batchSize : 0;
    final batch = _pending.sublist(start);
    _pending.clear();
    return batch;
  }

  /// Puts a batch that never landed back at the front, keeping call order.
  void restore(List<VoiceCallCaption> batch) {
    if (batch.isEmpty) return;
    _pending.insertAll(0, batch);
    if (_pending.length > _capacity) {
      _pending.removeRange(0, _pending.length - _capacity);
    }
  }

  void clear() => _pending.clear();
}
