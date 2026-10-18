import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/config/app_config.dart';
import '../../features/app_update/domain/app_update.dart';
import '../../features/auth/domain/auth_models.dart';
import '../../features/auth/domain/legal_gate.dart';
import '../../features/auth/presentation/auth_controller.dart';
import '../storage/file_transfer.dart';
import 'api_error.dart';
import 'auth_token_store.dart';
import 'downloaded_file.dart';
import 'streaming_browser_adapter.dart';

export 'downloaded_file.dart';

part 'chat_stream.dart';

final dioProvider = Provider<Dio>((ref) {
  final config = ref.watch(appConfigProvider);
  final build = ref.watch(appBuildProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl.toString(),
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 20),
      // The build rides every request so the server can turn away one it has
      // retired, whatever screen the request came from (see `AppBuild`).
      headers: {'Accept': 'application/json', ...?build?.headers},
    ),
  );
  if (kIsWeb) {
    dio.httpClientAdapter = StreamingBrowserAdapter(dio.httpClientAdapter);
  }
  ref.onDispose(dio.close);
  return dio;
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    dio: ref.watch(dioProvider),
    tokenStore: ref.watch(authTokenStoreProvider),
    onLegalAcceptanceRequired: () =>
        ref.read(legalGateDismissedProvider.notifier).reset(),
    onAppUpdateRequired: (details) =>
        ref.read(appUpdateStatusProvider.notifier).reportRequired(details),
    onSessionLost: () =>
        ref.read(authControllerProvider.notifier).sessionLost(),
  );
});

/// Bearer headers for API-owned assets that Flutter loads outside [Dio].
///
/// Keeping this beside [apiClientProvider] means image authorization does not
/// have to be forwarded through every feature repository that happens to own
/// an authenticated image URL.
///
/// Any authenticated picture on screen keeps this provider alive — the book
/// header's cover never leaves — so a header computed once outlived its
/// fifteen-minute access token, and every portrait and cover loaded after that
/// was a 401. It re-reads itself just inside the client's refresh window,
/// where the re-read is what mints the next token.
final apiAuthHeadersProvider = FutureProvider.autoDispose((ref) async {
  final tokens = await ref.watch(apiClientProvider).validTokens();
  final renewIn = tokens.refreshDueIn + const Duration(seconds: 1);
  final timer = Timer(
    renewIn < minHeaderRenewal ? minHeaderRenewal : renewIn,
    ref.invalidateSelf,
  );
  ref.onDispose(timer.cancel);
  return {'Authorization': 'Bearer ${tokens.accessToken}'};
});

/// The soonest [apiAuthHeadersProvider] re-reads itself, whatever the token
/// says. A re-read of a token that looks due is a refresh, so with no floor a
/// clock the client could not correct for (a server that does not send the
/// token's lifetime) refreshed once a second. It stays under the 45 seconds
/// the client refreshes ahead of expiry, so a header is replaced before its
/// token stops working.
const minHeaderRenewal = Duration(seconds: 30);

/// Codes that end the session whichever request they answer: a revoked
/// session stays revoked, and a disabled account stays disabled.
///
/// `INVALID_SESSION` and `SESSION_EXPIRED` are not here. On an ordinary
/// request they say only that *this access token* is done — rotated by a
/// refresh that raced the request, or past its fifteen minutes — and the
/// refresh that follows decides. From the refresh route every auth refusal is
/// final (`_refreshTokens`).
const _sessionEndingCodes = {'SESSION_REVOKED', 'ACCOUNT_DISABLED'};

/// Receive timeout for endpoints whose response waits on a full LLM turn
/// (creation chat, project chat, build preflight). The global 20s default
/// would misreport a slow-but-healthy model reply as a network error.
const llmReceiveTimeout = Duration(seconds: 120);


class ApiClient {
  ApiClient({
    required this.dio,
    required this.tokenStore,
    this.onLegalAcceptanceRequired,
    this.onAppUpdateRequired,
    this.onSessionLost,
  });

  final Dio dio;
  final AuthTokenStore tokenStore;

  /// Called once the server has stopped honouring this install's session, with
  /// the stored tokens already cleared: the refresh was refused, the refresh
  /// token ran out, the store came back empty, or a request was answered by a
  /// revoked session or a disabled account. The app signs the reader out.
  ///
  /// Before this, nothing told the app: the router still saw a session, every
  /// screen failed with "Sign in again to continue.", and the only way out was
  /// Account → Log out. Never called for a network failure, nor for a session
  /// the store has already moved past (see [_loseSession]).
  final void Function()? onSessionLost;

  /// Called when the server refuses a request with 428: the account has not
  /// accepted the current legal documents. Re-arms the updated-terms gate a
  /// "Not now" had dismissed, so the router walks the reader back to it.
  final void Function()? onLegalAcceptanceRequired;

  /// Called with the error body when the server refuses a request with 426:
  /// the operator has retired this build. The router follows the status this
  /// sets to the update screen.
  final void Function(Map<String, dynamic> details)? onAppUpdateRequired;

  /// Coalesces concurrent refresh attempts. The backend rotates the refresh
  /// token on every call, so parallel refreshes desync the stored pair from
  /// the server and brick the session.
  Future<MobileSessionTokens>? _refreshInFlight;
  int? _refreshGeneration;

  Future<Response<dynamic>> getJson(String path, {bool requiresAuth = true}) {
    return _request('GET', path, requiresAuth: requiresAuth);
  }

  Future<Map<String, dynamic>> getMap(
    String path, {
    bool requiresAuth = true,
  }) async {
    final response = await getJson(path, requiresAuth: requiresAuth);
    return response.data as Map<String, dynamic>;
  }

  /// An event stream whose HTTP request is aborted when the listener cancels.
  ///
  /// Cancelling the Dart subscription alone left the socket open: the status
  /// provider is rebuilt every few seconds while a book works, each rebuild
  /// opened a new stream, and the server kept every abandoned one alive —
  /// polling the database each second for it — until the book settled (three
  /// concurrent streams for one book, 2026-10-01). The cancel aborts the
  /// request through its token, at once.
  ///
  /// Built on a controller rather than an `async*` generator on purpose. A
  /// generator waiting inside `await for` does not see a cancel until its next
  /// `yield`, so a stream cancelled between events kept its socket until the
  /// server next sent one — and a server that sends only changes and `: ping`
  /// comments (which yield nothing) might not send one for minutes.
  ///
  /// [idleTimeout] bounds the silence between any two bytes — a `: ping`
  /// comment counts — and fails the stream with a `NETWORK_ERROR` when it
  /// passes. Without it a socket a network switch had silently killed was
  /// waited on forever: nothing errors on a dead TCP connection that is only
  /// ever read.
  Stream<ServerSentEvent> getServerSentEvents(
    String path, {
    bool requiresAuth = true,
    Duration? idleTimeout,
  }) {
    final cancelToken = CancelToken();
    StreamSubscription<ServerSentEvent>? events;
    var listening = true;
    late final StreamController<ServerSentEvent> controller;

    void abort() {
      if (!cancelToken.isCancelled) {
        cancelToken.cancel('Event stream closed by its listener.');
      }
    }

    void fail(Object error, StackTrace stackTrace) {
      abort();
      if (!listening) return;
      controller.addError(_eventStreamFailure(error), stackTrace);
      unawaited(controller.close());
    }

    Future<void> open() async {
      final Response<ResponseBody> response;
      try {
        response = await _streamRequest(
          path,
          requiresAuth: requiresAuth,
          cancelToken: cancelToken,
          receiveTimeout: idleTimeout,
        );
      } catch (error, stackTrace) {
        fail(error, stackTrace);
        return;
      }
      final body = response.data;
      if (!listening) {
        // Cancelled while the request was in flight: `abort` has run.
        return;
      }
      if (body == null) {
        abort();
        unawaited(controller.close());
        return;
      }
      final bytes = idleTimeout == null
          ? body.stream
          : body.stream.timeout(idleTimeout);
      events = _decodeServerSentEvents(bytes).listen(
        controller.add,
        onError: fail,
        onDone: () {
          abort();
          unawaited(controller.close());
        },
        cancelOnError: true,
      );
      if (controller.isPaused) events?.pause();
    }

    controller = StreamController<ServerSentEvent>(
      onListen: () => unawaited(open()),
      onPause: () => events?.pause(),
      onResume: () => events?.resume(),
      onCancel: () {
        listening = false;
        abort();
        final subscription = events;
        events = null;
        return subscription?.cancel();
      },
    );
    return controller.stream;
  }

  /// What a failed event stream reports: an [ApiException], like every other
  /// request, so a caller deciding whether to reconnect reads one type.
  Object _eventStreamFailure(Object error) {
    if (error is DioException) return _mapDioException(error);
    if (error is TimeoutException) {
      return const ApiException(
        code: 'NETWORK_ERROR',
        message: 'Check your connection and try again.',
      );
    }
    return error;
  }

  Future<Map<String, String>> authHeaders() async {
    final generation = tokenStore.generation;
    final accessToken = await _validAccessToken(generation);
    _assertCurrentSession(generation);
    return {'Authorization': 'Bearer $accessToken'};
  }

  Future<Response<dynamic>> postJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) {
    return _request(
      'POST',
      path,
      data: data,
      requiresAuth: requiresAuth,
      receiveTimeout: receiveTimeout,
    );
  }

  Future<Map<String, dynamic>> postMap(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) async {
    final response = await postJson(
      path,
      data: data,
      requiresAuth: requiresAuth,
      receiveTimeout: receiveTimeout,
    );
    return response.data as Map<String, dynamic>;
  }

  Future<Response<dynamic>> patchJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _request('PATCH', path, data: data, requiresAuth: requiresAuth);
  }

  /// A JSON body replacing a resource (the Writing Studio's chapter saves, a
  /// book's share). [receiveTimeout] is for a replace the server answers only
  /// after a model has read it.
  Future<Response<dynamic>> putJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
    Duration? receiveTimeout,
  }) {
    return _request(
      'PUT',
      path,
      data: data,
      requiresAuth: requiresAuth,
      receiveTimeout: receiveTimeout,
    );
  }

  /// Same transport as [postBytes] with PUT semantics (idempotent replace).
  Future<Response<dynamic>> putBytes(
    String path, {
    required List<int> bytes,
    Map<String, String>? queryParameters,
    void Function(int sent, int total)? onSendProgress,
  }) {
    return postBytes(
      path,
      bytes: bytes,
      queryParameters: queryParameters,
      onSendProgress: onSendProgress,
      method: 'PUT',
    );
  }

  /// Uploads raw bytes (chat attachments); metadata travels as query params.
  Future<Response<dynamic>> postBytes(
    String path, {
    required List<int> bytes,
    Map<String, String>? queryParameters,
    void Function(int sent, int total)? onSendProgress,
    String method = 'POST',
  }) async {
    Options buildOptions(String accessToken) {
      return Options(
        method: method,
        contentType: 'application/octet-stream',
        sendTimeout: const Duration(minutes: 3),
        receiveTimeout: const Duration(minutes: 3),
        headers: {
          'Authorization': 'Bearer $accessToken',
          Headers.contentLengthHeader: bytes.length.toString(),
        },
      );
    }

    final generation = tokenStore.generation;
    final accessToken = await _validAccessToken(generation);
    try {
      return await _withSession(
        generation,
        () => dio.request<dynamic>(
          path,
          data: Stream.fromIterable([bytes]),
          queryParameters: queryParameters,
          options: buildOptions(accessToken),
          onSendProgress: onSendProgress,
        ),
      );
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) {
        final tokens = await _refreshForSession(generation);
        return _mapped(
          () => dio.request<dynamic>(
            path,
            data: Stream.fromIterable([bytes]),
            queryParameters: queryParameters,
            options: buildOptions(tokens.accessToken),
            onSendProgress: onSendProgress,
          ),
          generation: generation,
        );
      }
      throw _mapDioException(error, generation: generation);
    }
  }

  Future<Response<dynamic>> deleteJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _request('DELETE', path, data: data, requiresAuth: requiresAuth);
  }

  /// Downloads [path] to [savePath], and reports what the response said.
  ///
  /// [onReceiveProgress] reports bytes received; its `total` is -1 when the
  /// response carries no Content-Length. [cancelToken] lets a caller abandon a
  /// download it no longer needs — the reader cancels when the screen closes
  /// mid-download.
  ///
  /// The headers come back because the bytes cannot be identified without them:
  /// a caller that has to record *what* it downloaded has only the response to
  /// learn it from. Callers that just want the file ignore the result.
  Future<DownloadedFile> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    final generation = tokenStore.generation;
    final accessToken = await _validAccessToken(generation);
    try {
      return DownloadedFile.fromResponse(
        await _withSession(
          generation,
          () => downloadToFile(
            dio,
            path,
            savePath,
            options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
            onReceiveProgress: onReceiveProgress,
            cancelToken: cancelToken,
          ),
        ),
      );
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) {
        final tokens = await _refreshForSession(generation);
        return DownloadedFile.fromResponse(
          await _mapped(
            () => downloadToFile(
              dio,
              path,
              savePath,
              options: Options(
                headers: {'Authorization': 'Bearer ${tokens.accessToken}'},
              ),
              onReceiveProgress: onReceiveProgress,
              cancelToken: cancelToken,
            ),
            generation: generation,
          ),
        );
      }
      throw _mapDioException(error, generation: generation);
    }
  }

  Future<MobileSessionTokens> refreshTokens() {
    return _refreshForSession(tokenStore.generation);
  }

  Future<MobileSessionTokens> _refreshForSession(int generation) {
    _assertCurrentSession(generation);
    final inFlight = _refreshInFlight;
    if (inFlight != null && _refreshGeneration == generation) {
      return inFlight;
    }
    late final Future<MobileSessionTokens> refresh;
    refresh = _refreshTokens(generation).whenComplete(() {
      // An old completion must not discard a newer account's refresh slot.
      if (identical(_refreshInFlight, refresh)) {
        _refreshInFlight = null;
        _refreshGeneration = null;
      }
    });
    _refreshInFlight = refresh;
    _refreshGeneration = generation;
    return refresh;
  }

  Future<MobileSessionTokens> _refreshTokens(int generation) async {
    final current = await tokenStore.read();
    _assertCurrentSession(generation);
    if (current == null || current.isRefreshExpired) {
      await _loseSession(generation);
      throw const ApiException(
        code: 'SESSION_EXPIRED',
        message: 'Sign in again to continue.',
        statusCode: 401,
      );
    }

    try {
      final requestedAt = DateTime.now();
      final response = await dio.post<dynamic>(
        '/api/mobile/auth/refresh',
        data: {'refreshToken': current.refreshToken},
        options: Options(contentType: Headers.jsonContentType),
      );
      _assertCurrentSession(generation);
      final data = response.data as Map<String, dynamic>;
      final tokens = MobileSessionTokens.fromJson(
        data['session'] as Map<String, dynamic>,
        requestedAt: requestedAt,
      );
      await tokenStore.writeIfCurrent(generation, tokens);
      _assertCurrentSession(generation);
      return tokens;
    } on DioException catch (error) {
      _assertCurrentSession(generation);
      final mapped = _mapDioException(error);
      // The refresh token is the session: once the server refuses it —
      // revoked by a password reset elsewhere, deleted with the account, or
      // reused after a lost response and the whole session revoked for it —
      // no request this install makes can succeed again. A network failure
      // is not an answer and changes nothing.
      if (mapped.isAuthFailure) await _loseSession(generation);
      throw mapped;
    }
  }

  /// Ends the stored session that [generation] still owns, and tells the app.
  ///
  /// Synchronous up to the callback: the generation check, the clear's
  /// generation bump and the call happen in one turn, so no sign-in or logout
  /// can land between deciding the session is this one and signing it out. A
  /// failure from an older session finds the generation moved on and does
  /// nothing — it cannot sign out the account that replaced it.
  Future<void> _loseSession(int generation) {
    if (tokenStore.generation != generation) return Future.value();
    final cleared = tokenStore.clearIfCurrent(generation);
    onSessionLost?.call();
    return cleared;
  }

  Future<Response<dynamic>> _request(
    String method,
    String path, {
    Object? data,
    bool requiresAuth = true,
    bool retryOnAuthFailure = true,
    Duration? receiveTimeout,
  }) async {
    final generation = requiresAuth ? tokenStore.generation : null;
    final options = Options(
      method: method,
      contentType: data == null ? null : Headers.jsonContentType,
      receiveTimeout: receiveTimeout,
    );
    if (requiresAuth) {
      final accessToken = await _validAccessToken(generation);
      options.headers = {'Authorization': 'Bearer $accessToken'};
    }

    try {
      return await _withSession(
        generation,
        () => dio.request<dynamic>(path, data: data, options: options),
      );
    } on DioException catch (error) {
      if (requiresAuth &&
          retryOnAuthFailure &&
          error.response?.statusCode == 401) {
        final tokens = await _refreshForSession(generation!);
        return _mapped(
          () => dio.request<dynamic>(
            path,
            data: data,
            options: Options(
              method: method,
              contentType: data == null ? null : Headers.jsonContentType,
              receiveTimeout: receiveTimeout,
              headers: {'Authorization': 'Bearer ${tokens.accessToken}'},
            ),
          ),
          generation: generation,
        );
      }
      throw _mapDioException(error, generation: generation);
    }
  }

  Future<Response<ResponseBody>> _streamRequest(
    String path, {
    String method = 'GET',
    String accept = 'text/event-stream',
    Object? data,
    Duration? receiveTimeout,
    bool requiresAuth = true,
    bool retryOnAuthFailure = true,
    CancelToken? cancelToken,
  }) async {
    final generation = requiresAuth ? tokenStore.generation : null;
    final options = Options(
      method: method,
      responseType: ResponseType.stream,
      receiveTimeout: receiveTimeout ?? Duration.zero,
      headers: {'Accept': accept},
    );
    if (requiresAuth) {
      final accessToken = await _validAccessToken(generation);
      options.headers = {
        ...?options.headers,
        'Authorization': 'Bearer $accessToken',
      };
    }

    try {
      return await _withSession(
        generation,
        () => dio.request<ResponseBody>(
          path,
          data: data,
          options: options,
          cancelToken: cancelToken,
        ),
      );
    } on DioException catch (error) {
      if (requiresAuth &&
          retryOnAuthFailure &&
          error.response?.statusCode == 401) {
        final tokens = await _refreshForSession(generation!);
        return _mapped(
          () => dio.request<ResponseBody>(
            path,
            data: data,
            cancelToken: cancelToken,
            options: Options(
              method: method,
              responseType: ResponseType.stream,
              receiveTimeout: receiveTimeout ?? Duration.zero,
              headers: {
                'Accept': accept,
                'Authorization': 'Bearer ${tokens.accessToken}',
              },
            ),
          ),
          generation: generation,
        );
      }
      await _decodeStreamError(error);
      throw _mapDioException(error, generation: generation);
    }
  }

  Future<String> _validAccessToken(int? generation) async {
    return (await _validTokensForSession(
      generation ?? tokenStore.generation,
    )).accessToken;
  }

  /// The stored session, refreshed first when its access token is about to
  /// expire.
  Future<MobileSessionTokens> validTokens() {
    return _validTokensForSession(tokenStore.generation);
  }

  Future<MobileSessionTokens> _validTokensForSession(int generation) async {
    final tokens = await tokenStore.read();
    _assertCurrentSession(generation);
    if (tokens == null) {
      // Nothing stored under a live generation: a store that could not be
      // read clears itself without moving the generation. Signed out, this
      // is a no-op for the app; signed in, it is a session to give up.
      await _loseSession(generation);
      throw const ApiException(
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue.',
        statusCode: 401,
      );
    }
    if (tokens.isRefreshExpired) {
      await _loseSession(generation);
      throw const ApiException(
        code: 'SESSION_EXPIRED',
        message: 'Sign in again to continue.',
        statusCode: 401,
      );
    }
    if (tokens.shouldRefreshAccessToken) {
      return _refreshForSession(generation);
    }
    return tokens;
  }

  void _assertCurrentSession(int generation) {
    if (tokenStore.generation != generation) {
      // Cancellation, not an auth failure: callers must not sign out or clear
      // the new account in response to an old account's abandoned request.
      throw const ApiException(
        code: 'REQUEST_CANCELLED',
        message: 'The request was canceled because your sign-in changed.',
      );
    }
  }

  /// Runs [send] and maps any Dio failure onto an [ApiException].
  ///
  /// Every retry after a token refresh goes through here, and that is the
  /// whole point: the retry is an ordinary request, so it fails in ordinary
  /// ways. A `401 → refresh → 404 EXPORT_NOT_READY` reaching the reader as a
  /// raw `DioException` matches neither `_isRebuilding` nor `_isPaymentFailure`
  /// in `reader_overlays.dart` — both test `is ApiException` first — so an
  /// expired access token would downgrade the "still preparing" overlay to a
  /// dead "Could not download this book".
  Future<T> _mapped<T>(Future<T> Function() send, {int? generation}) async {
    try {
      return await _withSession(generation, send);
    } on DioException catch (error) {
      await _decodeStreamError(error);
      throw _mapDioException(error, generation: generation);
    }
  }

  /// A late 401 must not replay an old request with the next user's tokens.
  /// The same fence keeps a late successful response out of the new account.
  Future<T> _withSession<T>(int? generation, Future<T> Function() send) async {
    if (generation != null) _assertCurrentSession(generation);
    try {
      final result = await send();
      if (generation != null) _assertCurrentSession(generation);
      return result;
    } on DioException {
      if (generation != null) _assertCurrentSession(generation);
      rethrow;
    }
  }

  /// The failure a caller sees. [generation] is the session an authenticated
  /// request was sent under; when the answer ends that session, the session
  /// is given up here, on the one path every final failure takes.
  ApiException _mapDioException(DioException error, {int? generation}) {
    final mapped = _toApiException(error);
    if (generation != null && _sessionEndingCodes.contains(mapped.code)) {
      unawaited(_loseSession(generation));
    }
    return mapped;
  }

  ApiException _toApiException(DioException error) {
    final response = error.response;
    if (response?.statusCode == 428) {
      onLegalAcceptanceRequired?.call();
    }
    final data = response?.data;
    if (response?.statusCode == 426) {
      final errorBody = data is Map<String, dynamic> ? data['error'] : null;
      onAppUpdateRequired?.call(
        errorBody is Map<String, dynamic> ? errorBody : const {},
      );
    }
    if (data is Map<String, dynamic>) {
      final errorBody = data['error'];
      if (errorBody is Map<String, dynamic>) {
        return ApiException(
          code: errorBody['code'] as String? ?? 'API_ERROR',
          message: errorBody['message'] as String? ?? 'Something went wrong.',
          statusCode: response?.statusCode,
          details: errorBody,
          retryAfter: retryAfterFromHeader(
            response?.headers.value('retry-after'),
          ),
        );
      }
    }

    if (error.type == DioExceptionType.cancel) {
      // The caller abandoned this request on purpose (a reader closing
      // mid-download); a generic API_ERROR would present their own action back
      // to them as a failure.
      return const ApiException(
        code: 'REQUEST_CANCELLED',
        message: 'The request was cancelled.',
      );
    }

    if (error.type == DioExceptionType.connectionError ||
        error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout ||
        error.type == DioExceptionType.sendTimeout) {
      return const ApiException(
        code: 'NETWORK_ERROR',
        message: 'Check your connection and try again.',
      );
    }

    // No API error body: a proxy's page ("502 Bad Gateway"), a body the
    // server never finished, or no response at all. The HTTP reason phrase is
    // for people reading logs, so the reader gets a sentence instead.
    return ApiException(
      code: 'API_ERROR',
      message: _unexplainedFailureMessage(response?.statusCode),
      statusCode: response?.statusCode,
    );
  }
}

/// A `Retry-After` header in delta-seconds, the only form the API writes.
/// An HTTP date, a negative number or anything unreadable is no wait at all,
/// so a caller falls back to its own default rather than to a guess.
Duration? retryAfterFromHeader(String? value) {
  final seconds = int.tryParse(value?.trim() ?? '');
  if (seconds == null || seconds < 0) return null;
  return Duration(seconds: seconds);
}

/// What a failure with no API error body says to the reader. A gateway or an
/// overloaded server is temporary, so it says to try again shortly rather than
/// that something is broken.
String _unexplainedFailureMessage(int? statusCode) {
  if (statusCode != null && statusCode >= 500) {
    return 'Tomeza is having trouble right now. Try again in a moment.';
  }
  return 'Something went wrong. Try again.';
}

class ServerSentEvent {
  const ServerSentEvent({required this.event, required this.data});

  final String event;
  final String data;
}

/// Splits an event stream's bytes into events.
///
/// A transformer chain, not an `async*` generator, so a cancel reaches the
/// socket at once (see [ApiClient.getServerSentEvents]).
Stream<ServerSentEvent> _decodeServerSentEvents(Stream<List<int>> stream) {
  var event = 'message';
  final dataLines = <String>[];

  void reset() {
    event = 'message';
    dataLines.clear();
  }

  // `bind`, not `stream.transform(utf8.decoder)`: Dio hands back a
  // `Stream<Uint8List>`, and `transform` checks the decoder against that
  // runtime type — a `StreamTransformer<List<int>, String>` is not a
  // `StreamTransformer<Uint8List, String>` — so every event stream threw on its
  // first byte, the status watch fell back to polling, and the abandoned socket
  // stayed open on the server.
  return utf8.decoder
      .bind(stream)
      .transform(const LineSplitter())
      .transform(
        StreamTransformer<String, ServerSentEvent>.fromHandlers(
          handleData: (line, sink) {
            if (line.isEmpty) {
              if (dataLines.isNotEmpty) {
                sink.add(
                  ServerSentEvent(event: event, data: dataLines.join('\n')),
                );
              }
              reset();
              return;
            }
            // A comment: the server's `: ping` heartbeat. It has already
            // counted as activity against the idle timeout; it is not an event.
            if (line.startsWith(':')) return;

            final separator = line.indexOf(':');
            final field = separator == -1 ? line : line.substring(0, separator);
            var value = separator == -1 ? '' : line.substring(separator + 1);
            if (value.startsWith(' ')) {
              value = value.substring(1);
            }

            switch (field) {
              case 'event':
                event = value;
              case 'data':
                dataLines.add(value);
            }
          },
          handleDone: (sink) {
            if (dataLines.isNotEmpty) {
              sink.add(
                ServerSentEvent(event: event, data: dataLines.join('\n')),
              );
            }
            sink.close();
          },
        ),
      );
}
