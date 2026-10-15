import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/project_status_watch.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/lifecycle/app_resume_signal.dart';

// The status watch has to outlive an outage. Before 2026-10-13 a status read
// that threw ended the stream, Riverpod's retry gave up after ~38 s, and a
// book's live progress froze until the reader left the screen.
void main() {
  const offline = ApiException(
    code: 'NETWORK_ERROR',
    message: 'Check your connection and try again.',
  );

  testWidgets('a poll that fails mid-book backs off and carries on', (
    tester,
  ) async {
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)], closeAfter: true))
      ..polls.addAll([
        _Poll.fail(offline),
        _Poll.fail(offline),
        _Poll.fail(offline),
        _Poll.ok(_status(55)),
      ]);
    final harness = _Harness(tester, repository);

    await tester.pump();
    expect(harness.latest?.progressPercent, 40);

    // Read at once, then after 3 s, 6 s and 12 s of backoff.
    expect(repository.pollCalls, 1);
    await tester.pump(const Duration(seconds: 3));
    expect(repository.pollCalls, 2);
    await tester.pump(const Duration(seconds: 6));
    expect(repository.pollCalls, 3);
    await tester.pump(const Duration(seconds: 12));
    await tester.pump();

    expect(repository.pollCalls, 4);
    expect(harness.latest?.progressPercent, 55);
    expect(
      harness.errors,
      isEmpty,
      reason: 'the page keeps the status it has through the outage',
    );
    await harness.close();
  });

  testWidgets('an event stream that timed out is reopened once the API '
      'answers again', (tester) async {
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)], failWith: offline))
      ..events.add(_EventScript(statuses: [_status(70)]))
      ..polls.addAll([_Poll.fail(offline), _Poll.ok(_status(50))]);
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump();
    expect(repository.pollCalls, 1, reason: 'one read right after the drop');
    expect(repository.eventStreamsOpened, 1);

    await tester.pump(const Duration(seconds: 3));
    expect(harness.latest?.progressPercent, 50);

    // Back on the event stream after the usual pause, not polling for good.
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(repository.eventStreamsOpened, 2);
    expect(harness.latest?.progressPercent, 70);
    expect(repository.pollCalls, 2);
    await harness.close();
  });

  testWidgets('an event stream the server closed mid-book falls back to '
      'polling quietly', (tester) async {
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)], closeAfter: true))
      ..polls.addAll([_Poll.ok(_status(45)), _Poll.ok(_status(50))]);
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();

    expect(harness.latest?.progressPercent, 50);
    expect(repository.eventStreamsOpened, 1);
    expect(harness.errors, isEmpty);
    await harness.close();
  });

  testWidgets('before the first status a failure is shown, and the watch '
      'recovers on its own', (tester) async {
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(failWith: offline))
      ..polls.addAll([_Poll.fail(offline), _Poll.ok(_status(30))]);
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump();
    expect(harness.container.read(_provider).hasError, isTrue);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();

    final value = harness.container.read(_provider);
    expect(value.hasError, isFalse);
    expect(value.value?.progressPercent, 30);
    await harness.close();
  });

  testWidgets('a refusal ends the watch with its error', (tester) async {
    const gone = ApiException(
      code: 'PROJECT_NOT_FOUND',
      message: 'Book not found.',
      statusCode: 404,
    );
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)], closeAfter: true))
      ..polls.add(_Poll.fail(gone));
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump();

    expect(harness.container.read(_provider).error, gone);
    await tester.pump(const Duration(seconds: 30));
    expect(repository.pollCalls, 1);
    await harness.close();
  });

  testWidgets('a heartbeat that resends the same status notifies no one', (
    tester,
  ) async {
    final repository = _ScriptedRepository()
      ..events.add(
        _EventScript(
          statuses: [
            _wireStatus(40),
            _wireStatus(40),
            _wireStatus(40),
            _wireStatus(41),
          ],
        ),
      );
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump();

    expect(harness.notified.map((status) => status.progressPercent), [40, 41]);
    await harness.close();
  });

  testWidgets('disposing the watch between events cancels the event stream '
      'at once', (tester) async {
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)]));
    final harness = _Harness(tester, repository);

    await tester.pump();
    expect(repository.openEventStreams, 1);

    harness.dispose();
    await tester.pump();
    expect(repository.openEventStreams, 0);
  });

  testWidgets('coming back to the app reopens a live book\'s watch', (
    tester,
  ) async {
    final resumes = StreamController<void>.broadcast();
    addTearDown(resumes.close);
    final repository = _ScriptedRepository()
      ..events.add(_EventScript(statuses: [_status(40)]))
      ..events.add(_EventScript(statuses: [_status(60)]));
    final harness = _Harness(tester, repository, resumes: resumes.stream);

    await tester.pump();
    expect(repository.eventStreamsOpened, 1);

    resumes.add(null);
    // Riverpod rebuilds on a zero-length timer.
    await tester.pump(Duration.zero);
    await tester.pump(Duration.zero);

    expect(repository.eventStreamsOpened, 2);
    expect(repository.openEventStreams, 1, reason: 'the old socket closed');
    expect(harness.latest?.progressPercent, 60);
    await harness.close();
  });

  testWidgets('coming back leaves a settled book\'s finished watch alone', (
    tester,
  ) async {
    final resumes = StreamController<void>.broadcast();
    addTearDown(resumes.close);
    final repository = _ScriptedRepository()
      ..events.add(
        _EventScript(statuses: [_status(100, status: 'complete')]),
      );
    final harness = _Harness(tester, repository, resumes: resumes.stream);

    await tester.pump();
    resumes.add(null);
    await tester.pump(Duration.zero);
    await tester.pump(Duration.zero);

    expect(repository.eventStreamsOpened, 1);
    await harness.close();
  });

  testWidgets('a stream whose token ran out is reopened, not given up on', (
    tester,
  ) async {
    // The server ends every status stream when the access token it opened
    // with expires — about every fifteen minutes.
    final repository = _ScriptedRepository()
      ..events.add(
        _EventScript(
          statuses: [_status(40)],
          failWith: statusStreamEnding(
            '{"code":"STATUS_STREAM_SESSION_ENDED"}',
          ),
        ),
      )
      ..events.add(_EventScript(statuses: [_status(60)]))
      ..polls.add(_Poll.ok(_status(50)));
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();

    expect(repository.eventStreamsOpened, 2);
    expect(harness.latest?.progressPercent, 60);
    expect(harness.errors, isEmpty, reason: 'not a sign-out, not an error');
    await harness.close();
  });

  testWidgets('a stream whose seat went to a newer one falls back to polling', (
    tester,
  ) async {
    // Reopening would only evict another of the reader's streams.
    final repository = _ScriptedRepository()
      ..events.add(
        _EventScript(
          statuses: [_status(40)],
          failWith: statusStreamEnding('{"code":"STATUS_STREAM_REPLACED"}'),
        ),
      )
      ..polls.addAll([_Poll.ok(_status(50)), _Poll.ok(_status(55))]);
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump(const Duration(seconds: 3));

    expect(repository.eventStreamsOpened, 1);
    expect(repository.pollCalls, 2);
    expect(harness.latest?.progressPercent, 55);
    await harness.close();
  });

  testWidgets('a stream that keeps dying empty stops being reopened', (
    tester,
  ) async {
    final repository = _ScriptedRepository();
    for (var i = 0; i < 6; i++) {
      repository.events.add(_EventScript(failWith: offline));
    }
    final harness = _Harness(tester, repository);

    await tester.pump();
    await tester.pump(const Duration(minutes: 5));

    expect(repository.eventStreamsOpened, 3);
    expect(repository.pollCalls, greaterThan(10), reason: 'polling instead');
    await harness.close();
  });

  test('only the error events that end a stream are reported', () {
    expect(
      statusStreamEnding('{"code":"STATUS_STREAM_SESSION_ENDED"}')?.code,
      'STATUS_STREAM_SESSION_ENDED',
    );
    expect(
      statusStreamEnding('{"code":"STATUS_STREAM_REPLACED"}')?.code,
      'STATUS_STREAM_REPLACED',
    );
    expect(
      statusStreamEnding('{"code":"PROJECT_NOT_FOUND"}')?.statusCode,
      404,
    );
    expect(statusStreamEnding('{"code":"STATUS_STREAM_ERROR"}'), isNull);
    expect(statusStreamEnding('not json'), isNull);
  });

  test('the poll interval backs off to half a minute', () {
    expect(
      [for (var i = 0; i <= 6; i++) statusPollInterval(i).inSeconds],
      [3, 3, 6, 12, 24, 30, 30],
    );
  });

  test('only a failure worth repeating is retried', () {
    expect(isTransientStatusFailure(TimeoutException('idle')), isTrue);
    expect(
      isTransientStatusFailure(
        const ApiException(code: 'API_ERROR', message: '', statusCode: 502),
      ),
      isTrue,
    );
    expect(
      isTransientStatusFailure(
        const ApiException(code: 'X', message: '', statusCode: 404),
      ),
      isFalse,
    );
    expect(
      isTransientStatusFailure(
        const ApiException(code: 'REQUEST_CANCELLED', message: ''),
      ),
      isFalse,
    );
    expect(isTransientStatusFailure(TypeError()), isFalse);
  });
}

final _provider = projectStatusProvider('project-1');

class _Harness {
  _Harness(
    this.tester,
    _ScriptedRepository repository, {
    Stream<void>? resumes,
  }) : container = ProviderContainer(
         overrides: [
           projectsRepositoryProvider.overrideWithValue(repository),
           appResumesProvider.overrideWithValue(
             resumes ?? const Stream<void>.empty(),
           ),
         ],
         // Riverpod's own retry would restart the watch; these tests are
         // about the watch's.
         retry: (_, _) => null,
       ) {
    _subscription = container.listen<AsyncValue<MobileProjectStatus>>(
      _provider,
      (_, next) {
        if (next.hasError && !next.isLoading) errors.add(next.error!);
        final value = next.asData?.value;
        if (value != null) notified.add(value);
      },
      fireImmediately: true,
    );
  }

  final WidgetTester tester;
  final ProviderContainer container;
  late final ProviderSubscription<AsyncValue<MobileProjectStatus>>
  _subscription;
  final notified = <MobileProjectStatus>[];
  final errors = <Object>[];
  bool _disposed = false;

  MobileProjectStatus? get latest => container.read(_provider).value;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _subscription.close();
    container.dispose();
  }

  /// Ends the watch inside the test body, where pending timers are checked.
  Future<void> close() async {
    dispose();
    await tester.pump();
  }
}

class _EventScript {
  _EventScript({
    this.statuses = const [],
    this.failWith,
    this.closeAfter = false,
  });

  final List<MobileProjectStatus> statuses;
  final Object? failWith;
  final bool closeAfter;
}

class _Poll {
  _Poll.ok(MobileProjectStatus this.status) : error = null;
  _Poll.fail(Object this.error) : status = null;

  final MobileProjectStatus? status;
  final Object? error;
}

class _ScriptedRepository implements ProjectsRepository {
  final events = Queue<_EventScript>();
  final polls = Queue<_Poll>();
  int eventStreamsOpened = 0;
  int openEventStreams = 0;
  int pollCalls = 0;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) {
    eventStreamsOpened += 1;
    final script = events.isEmpty ? _EventScript() : events.removeFirst();
    late final StreamController<MobileProjectStatus> controller;
    controller = StreamController<MobileProjectStatus>(
      onListen: () {
        openEventStreams += 1;
        script.statuses.forEach(controller.add);
        if (script.failWith case final error?) {
          controller.addError(error);
          unawaited(controller.close());
        } else if (script.closeAfter) {
          unawaited(controller.close());
        }
      },
      onCancel: () => openEventStreams -= 1,
    );
    controller.done.then((_) {
      if (controller.hasListener) openEventStreams -= 1;
    });
    return controller.stream;
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    pollCalls += 1;
    final poll = polls.isEmpty ? null : polls.removeFirst();
    if (poll == null) return _status(99);
    if (poll.error case final error?) throw error;
    return poll.status!;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectStatus _status(int percent, {String status = 'generating'}) {
  return MobileProjectStatus.fromJson(_statusJson(percent, status: status));
}

/// Always a fresh object from the same payload, as the wire delivers it.
MobileProjectStatus _wireStatus(int percent) => MobileProjectStatus.fromJson(
  jsonDecode(jsonEncode(_statusJson(percent))) as Map<String, dynamic>,
);

Map<String, dynamic> _statusJson(int percent, {String status = 'generating'}) {
  Map<String, dynamic> file(String format) => {
    'format': format,
    'available': status == 'complete',
    'unlocked': true,
    'creditsRequired': 0,
    'downloadUrl': '/api/mobile/projects/project-1/export/$format',
    'filename': 'book.$format',
    'contentType': 'application/octet-stream',
  };
  return {
    'projectId': 'project-1',
    'status': status,
    'statusLabel': 'Writing',
    'progressPercent': percent,
    'currentAction': 'Writing your book pages.',
    'retryAvailable': false,
    'steps': const <Object>[],
    'pageProgress': {'completed': 4, 'target': 10},
    'imageCount': 0,
    'exports': {'pdf': file('pdf'), 'epub': file('epub')},
    'updatedAt': '2026-10-13T00:00:00.000Z',
  };
}
