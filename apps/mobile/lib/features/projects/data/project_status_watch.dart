import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import '../../../shared/api/api_error.dart';
import '../domain/project_models.dart';
import 'export_repair_watch.dart';
import 'projects_repository.dart';

/// How long the status event stream may stay silent before it counts as dead.
///
/// The server sends something — a changed status, or a heartbeat (a `: ping`
/// comment or the same status again) — at least every 15 seconds, so three
/// missed beats means the socket died without saying so: a network switch, a
/// phone that slept, a proxy that dropped it.
const statusStreamIdleTimeout = Duration(seconds: 45);

/// The pause between two status reads once the event stream is not in use:
/// three seconds while reads succeed, then doubling with each failure in a
/// row up to half a minute, so an outage is waited out without hammering the
/// API that is struggling.
Duration statusPollInterval(int consecutiveFailures) {
  if (consecutiveFailures <= 1) return const Duration(seconds: 3);
  final seconds = 3 * math.pow(2, consecutiveFailures - 1).toInt();
  return Duration(seconds: math.min(seconds, 30));
}

/// The server's word that a status event stream is over, and why — as the
/// error the watch decides on — or null for an `error` event that ends
/// nothing (`STATUS_STREAM_ERROR`: one read failed and the stream goes on).
///
/// - `STATUS_STREAM_SESSION_ENDED`: the access token the stream opened with
///   ran out (about every fifteen minutes) or was refreshed. Not a sign-out —
///   a dead session shows itself on the next ordinary request — just a stream
///   to reopen with the current token.
/// - `STATUS_STREAM_REPLACED`: a newer stream of the same account took its
///   seat (the server keeps three). Reopening would only evict another, so the
///   watch polls instead.
/// - `PROJECT_NOT_FOUND`: the book is gone; the poll that follows says so.
ApiException? statusStreamEnding(String data) {
  Object? code;
  try {
    final decoded = jsonDecode(data);
    if (decoded is Map) code = decoded['code'];
  } on FormatException {
    return null;
  }
  return switch (code) {
    statusStreamSessionEnded => const ApiException(
      code: statusStreamSessionEnded,
      message: 'The status stream needs a fresh sign-in token.',
    ),
    statusStreamReplaced => const ApiException(
      code: statusStreamReplaced,
      message: 'A newer status stream replaced this one.',
    ),
    'PROJECT_NOT_FOUND' => const ApiException(
      code: 'PROJECT_NOT_FOUND',
      message: 'Book not found.',
      statusCode: 404,
    ),
    _ => null,
  };
}

const statusStreamSessionEnded = 'STATUS_STREAM_SESSION_ENDED';
const statusStreamReplaced = 'STATUS_STREAM_REPLACED';

/// Whether a failed status read is worth trying again: the network, a
/// timeout, a gateway or an overloaded server. A refusal (the book is gone,
/// the session is) and a payload this build cannot read are answers, and
/// asking again changes nothing.
bool isTransientStatusFailure(Object error) {
  if (error is ApiException) {
    if (error.code == 'REQUEST_CANCELLED') return false;
    final status = error.statusCode;
    if (status == null) return true;
    return status >= 500 || status == 408 || status == 429;
  }
  // A `TypeError` from a changed payload would fail the same way forever.
  return error is! Error;
}

/// Follows one book's status for as long as anything listens.
///
/// The event stream first; when it ends with something still to watch, short
/// polling. Two rules make an outage survivable:
///
/// - **A transient failure never ends the watch.** Before 2026-10-13 a read
///   that threw ended the stream, Riverpod's own retry gave up after about 38
///   seconds, and live progress froze until the reader left the screen. Now
///   the watch backs off ([statusPollInterval]) and keeps asking; the screen
///   keeps the last status it had. Only before the first status is a failure
///   reported, so a screen with nothing to show can say why — and the watch
///   carries on behind that error and replaces it when the API answers.
/// - **An event stream that broke is reopened once the API answers again.**
///   One that timed out or lost its connection is worth reopening; one the
///   server closed while the book is still live (it may end a reader's oldest
///   streams) or refused outright (an older API) is not, and the watch stays
///   on polling quietly.
///
/// A controller rather than an `async*` generator, because a generator waiting
/// inside `await for` sees a cancel only at its next `yield`: a provider
/// disposed between two events kept its socket — and its seat among the
/// reader's open streams — until the server next sent a status.
///
/// Duplicate statuses (the server's heartbeat may resend the one it already
/// sent) are dropped here; [MobileProjectStatus] compares by its payload.
Stream<MobileProjectStatus> watchProjectStatusWithFallback(
  ProjectsRepository repository,
  String id,
  StatusPollDelay pollDelay,
  ExportRepairWatchBudget repairWatch,
) {
  return _ProjectStatusWatch(repository, id, pollDelay, repairWatch).stream;
}

enum _EventStreamEnd {
  /// The book settled and nothing more is worth watching.
  settled,

  /// Timed out or lost its connection: worth reopening.
  interrupted,

  /// Closed by the server, or refused by it: poll from here on.
  closed,

  /// The listener left.
  cancelled,
}

class _ProjectStatusWatch {
  _ProjectStatusWatch(this.repository, this.id, this.pollDelay, this.repairWatch) {
    _out = StreamController<MobileProjectStatus>(
      onListen: () => unawaited(_run()),
      onPause: () => _events?.pause(),
      onResume: () {
        _events?.resume();
        _wake();
      },
      onCancel: _cancel,
    );
  }

  final ProjectsRepository repository;
  final String id;
  final StatusPollDelay pollDelay;
  final ExportRepairWatchBudget repairWatch;

  late final StreamController<MobileProjectStatus> _out;
  StreamSubscription<MobileProjectStatus>? _events;
  Completer<_EventStreamEnd>? _eventsEnded;
  Completer<void>? _resumed;
  MobileProjectStatus? _last;
  bool _delivered = false;
  bool _streamDelivered = false;
  bool _cancelled = false;

  static const _maxEmptyStreams = 3;

  Stream<MobileProjectStatus> get stream => _out.stream;

  Future<void> _run() async {
    var openEventStream = true;
    var reopenOnRecovery = false;
    var failures = 0;
    // Streams in a row that ended before telling us anything. Every healthy
    // stream says at least the status it opened on; one that keeps dying
    // empty is not worth reopening every few seconds.
    var emptyStreams = 0;
    while (!_cancelled) {
      if (openEventStream) {
        openEventStream = false;
        _streamDelivered = false;
        final end = await _followEventStream();
        emptyStreams = _streamDelivered ? 0 : emptyStreams + 1;
        switch (end) {
          case _EventStreamEnd.settled:
          case _EventStreamEnd.cancelled:
            _finish();
            return;
          case _EventStreamEnd.interrupted:
            // Its token ran out (the server ends every stream after about
            // fifteen minutes), it timed out, or the connection went: poll
            // meanwhile and open another once the API answers.
            reopenOnRecovery = emptyStreams < _maxEmptyStreams;
          case _EventStreamEnd.closed:
            // Falling out while there is still something to watch: the server
            // closed it (an export repair it just queued, a cap on a reader's
            // open streams, a restart), or an older API never offered it.
            reopenOnRecovery = false;
        }
      }

      await _untilResumed();
      if (_cancelled) return;
      final MobileProjectStatus status;
      try {
        status = await repository.getProjectStatus(id);
      } catch (error, stackTrace) {
        if (_cancelled) return;
        if (!isTransientStatusFailure(error)) {
          _out.addError(error, stackTrace);
          _finish();
          return;
        }
        failures += 1;
        // Nothing on screen yet: say why, and keep asking behind the error.
        if (!_delivered) _out.addError(error, stackTrace);
        if (!await pollDelay.wait(statusPollInterval(failures))) return;
        continue;
      }
      if (_cancelled) return;
      failures = 0;
      if (!_emit(status)) {
        _finish();
        return;
      }
      if (reopenOnRecovery && status.isLive) {
        reopenOnRecovery = false;
        openEventStream = true;
      }
      // A stream reopened after one that died empty waits longer each time.
      final pause = openEventStream ? emptyStreams : 0;
      if (!await pollDelay.wait(statusPollInterval(pause))) return;
    }
  }

  /// Hands [status] on unless it repeats the last one, and says whether the
  /// book is still worth watching.
  bool _emit(MobileProjectStatus status) {
    _delivered = true;
    if (status != _last) {
      _last = status;
      _out.add(status);
    }
    return repairWatch.shouldKeepWatching(status);
  }

  Future<_EventStreamEnd> _followEventStream() {
    final ended = Completer<_EventStreamEnd>();
    _eventsEnded = ended;
    void end(_EventStreamEnd how) {
      _events = null;
      if (!ended.isCompleted) ended.complete(how);
    }

    final Stream<MobileProjectStatus> events;
    try {
      events = repository.watchProjectStatus(id);
    } catch (error) {
      return Future.value(_eventStreamEndFor(error));
    }
    late final StreamSubscription<MobileProjectStatus> subscription;
    subscription = events.listen(
      (status) {
        _streamDelivered = true;
        if (_cancelled || _emit(status)) return;
        end(_EventStreamEnd.settled);
        unawaited(subscription.cancel());
      },
      onError: (Object error) => end(_eventStreamEndFor(error)),
      onDone: () => end(_EventStreamEnd.closed),
      cancelOnError: true,
    );
    if (!ended.isCompleted) {
      _events = subscription;
      if (_out.isPaused) subscription.pause();
    }
    return ended.future;
  }

  /// What a failed event stream means for the next one. A token that ran
  /// out, a timeout or a lost connection is worth reopening; a seat given to a
  /// newer stream, or a refusal, is not.
  static _EventStreamEnd _eventStreamEndFor(Object error) {
    if (error is ApiException && error.code == statusStreamReplaced) {
      return _EventStreamEnd.closed;
    }
    return isTransientStatusFailure(error)
        ? _EventStreamEnd.interrupted
        : _EventStreamEnd.closed;
  }

  /// A paused listener (a screen under another route) is not polled for; the
  /// event stream pauses with it.
  Future<void> _untilResumed() async {
    while (_out.isPaused && !_cancelled) {
      await (_resumed ??= Completer<void>()).future;
    }
  }

  void _wake() {
    final resumed = _resumed;
    _resumed = null;
    if (resumed != null && !resumed.isCompleted) resumed.complete();
  }

  void _finish() {
    if (!_out.isClosed) unawaited(_out.close());
  }

  Future<void>? _cancel() {
    _cancelled = true;
    pollDelay.dispose();
    _wake();
    final ended = _eventsEnded;
    if (ended != null && !ended.isCompleted) {
      ended.complete(_EventStreamEnd.cancelled);
    }
    final events = _events;
    _events = null;
    return events?.cancel();
  }
}

/// Owns the one pending short-poll delay so auto-disposing the provider also
/// cancels its timer. A bare `Future.delayed` keeps running after its stream
/// subscription is canceled, wasting work and leaving a timer behind when a
/// reader closes during an export repair.
class StatusPollDelay {
  Timer? _timer;
  Completer<bool>? _pending;
  bool _disposed = false;

  /// Completes with `true` after [duration], or `false` once disposed.
  Future<bool> wait([Duration duration = const Duration(seconds: 3)]) {
    if (_disposed) {
      return Future.value(false);
    }
    final pending = Completer<bool>();
    _pending = pending;
    _timer = Timer(duration, () {
      _timer = null;
      _pending = null;
      pending.complete(true);
    });
    return pending.future;
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted) {
      pending.complete(false);
    }
  }
}
