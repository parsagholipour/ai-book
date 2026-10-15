import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

// The status event stream as `GET …/status/events` sends it: a status only
// when it changed, a `: ping` comment every 15 s, and `error` events — some
// informational, some ending the stream.
void main() {
  test('pings and passing errors are not statuses; an ending is an error', () async {
    final adapter = _ScriptedStream();
    final repository = MobileProjectsRepository(apiClient: _client(adapter));

    final statuses = <int>[];
    final errors = <Object>[];
    final done = Completer<void>();
    repository
        .watchProjectStatus('project-1')
        .listen(
          (status) => statuses.add(status.progressPercent),
          onError: errors.add,
          onDone: done.complete,
        );

    await adapter.opened.future;
    adapter
      ..send(_statusEvent(40))
      ..send(': ping\n\n')
      ..send('event: error\ndata: {"code":"STATUS_STREAM_ERROR"}\n\n')
      ..send(_statusEvent(45))
      ..send('event: error\ndata: {"code":"STATUS_STREAM_SESSION_ENDED"}\n\n')
      ..end();
    await done.future.timeout(const Duration(seconds: 2));

    expect(statuses, [40, 45]);
    expect(errors, hasLength(1));
    expect(
      errors.single,
      isA<ApiException>().having(
        (error) => error.code,
        'code',
        'STATUS_STREAM_SESSION_ENDED',
      ),
    );
  });

  test('a resent status is the same status', () {
    final first = MobileProjectStatus.fromJson(_statusJson(40));
    final again = MobileProjectStatus.fromJson(_statusJson(40));
    final moved = MobileProjectStatus.fromJson(_statusJson(41));

    expect(again, first);
    expect(again.hashCode, first.hashCode);
    expect(moved, isNot(first));
  });
}

String _statusEvent(int percent) =>
    'event: status\ndata: ${jsonEncode({'status': _statusJson(percent)})}\n\n';

Map<String, dynamic> _statusJson(int percent) {
  Map<String, dynamic> file(String format) => {
    'format': format,
    'available': false,
    'unlocked': true,
    'creditsRequired': 0,
    'downloadUrl': '/api/mobile/projects/project-1/export/$format',
    'filename': 'book.$format',
    'contentType': 'application/octet-stream',
  };
  return {
    'projectId': 'project-1',
    'status': 'generating',
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

ApiClient _client(HttpClientAdapter adapter) {
  final now = DateTime.now().toUtc();
  return ApiClient(
    dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
      ..httpClientAdapter = adapter,
    tokenStore: MemoryAuthTokenStore(
      MobileSessionTokens(
        accessToken: 'access-token',
        accessTokenExpiresAt: now.add(const Duration(hours: 1)),
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: now.add(const Duration(days: 30)),
      ),
    ),
  );
}

class _ScriptedStream implements HttpClientAdapter {
  final _bytes = StreamController<Uint8List>();
  final opened = Completer<void>();

  void send(String text) => _bytes.add(Uint8List.fromList(utf8.encode(text)));

  void end() => _bytes.close();

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (!opened.isCompleted) opened.complete();
    return ResponseBody(
      _bytes.stream,
      200,
      headers: {
        Headers.contentTypeHeader: ['text/event-stream'],
      },
    );
  }
}
