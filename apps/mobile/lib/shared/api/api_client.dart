import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/config/app_config.dart';
import '../../features/auth/domain/auth_models.dart';
import '../../features/app_update/domain/app_update.dart';
import '../../features/auth/domain/legal_gate.dart';
import 'api_error.dart';
import 'auth_token_store.dart';

part 'chat_stream.dart';

final dioProvider = Provider<Dio>((ref) {
  final config = ref.watch(appConfigProvider);
  final build = ref.watch(appBuildProvider);
  return Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl.toString(),
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 20),
      // The build rides every request so the server can turn away one it has
      // retired, whatever screen the request came from (see `AppBuild`).
      headers: {'Accept': 'application/json', ...?build?.headers},
    ),
  );
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    dio: ref.watch(dioProvider),
    tokenStore: ref.watch(authTokenStoreProvider),
    onLegalAcceptanceRequired: () =>
        ref.read(legalGateDismissedProvider.notifier).reset(),
    onAppUpdateRequired: (details) =>
        ref.read(appUpdateStatusProvider.notifier).reportRequired(details),
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
  final renewIn = tokens.accessTokenRefreshAt
      .add(const Duration(seconds: 1))
      .difference(DateTime.now().toUtc());
  final timer = Timer(
    renewIn < const Duration(seconds: 1) ? const Duration(seconds: 1) : renewIn,
    ref.invalidateSelf,
  );
  ref.onDispose(timer.cancel);
  return {'Authorization': 'Bearer ${tokens.accessToken}'};
});

/// Receive timeout for endpoints whose response waits on a full LLM turn
/// (creation chat, project chat, build preflight). The global 20s default
/// would misreport a slow-but-healthy model reply as a network error.
const llmReceiveTimeout = Duration(seconds: 120);

/// What the server said about the bytes a download just wrote.
///
/// Only the headers, and only because one download needs them: a compiled
/// export is served from a URL that every compile of the book publishes over,
/// so the response — not the request, and not a status read taken before it —
/// is the only thing that can say which compile answered. See
/// `ExportProvenance`.
class DownloadedFile {
  const DownloadedFile({required this.headers});

  /// Response headers, names lower-cased, first value only.
  final Map<String, String> headers;

  String? header(String name) => headers[name.toLowerCase()];

  /// The length the response declared, or null when it declared none.
  int? get contentLength => int.tryParse(header('content-length') ?? '');

  static DownloadedFile fromResponse(Response<dynamic> response) {
    return DownloadedFile(
      headers: {
        for (final entry in response.headers.map.entries)
          if (entry.value.isNotEmpty)
            entry.key.toLowerCase(): entry.value.first,
      },
    );
  }
}

class ApiClient {
  ApiClient({
    required this.dio,
    required this.tokenStore,
    this.onLegalAcceptanceRequired,
    this.onAppUpdateRequired,
  });

  final Dio dio;
  final AuthTokenStore tokenStore;

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
  /// concurrent streams for one book, 2026-10-01). The generator's `finally`
  /// runs on cancellation, and the token is what closes the connection.
  Stream<ServerSentEvent> getServerSentEvents(
    String path, {
    bool requiresAuth = true,
  }) async* {
    final cancelToken = CancelToken();
    try {
      final response = await _streamRequest(
        path,
        requiresAuth: requiresAuth,
        cancelToken: cancelToken,
      );
      final body = response.data;
      if (body == null) {
        return;
      }
      yield* _decodeServerSentEvents(body.stream);
    } finally {
      if (!cancelToken.isCancelled) {
        cancelToken.cancel('Event stream closed by its listener.');
      }
    }
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
      throw _mapDioException(error);
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
          () => dio.download(
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
            () => dio.download(
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
      throw _mapDioException(error);
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
      await tokenStore.clearIfCurrent(generation);
      throw const ApiException(
        code: 'SESSION_EXPIRED',
        message: 'Sign in again to continue.',
        statusCode: 401,
      );
    }

    try {
      final response = await dio.post<dynamic>(
        '/api/mobile/auth/refresh',
        data: {'refreshToken': current.refreshToken},
        options: Options(contentType: Headers.jsonContentType),
      );
      _assertCurrentSession(generation);
      final data = response.data as Map<String, dynamic>;
      final tokens = MobileSessionTokens.fromJson(
        data['session'] as Map<String, dynamic>,
      );
      await tokenStore.writeIfCurrent(generation, tokens);
      _assertCurrentSession(generation);
      return tokens;
    } on DioException catch (error) {
      _assertCurrentSession(generation);
      final mapped = _mapDioException(error);
      if (mapped.isAuthFailure) {
        await tokenStore.clearIfCurrent(generation);
      }
      throw mapped;
    }
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
      throw _mapDioException(error);
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
      throw _mapDioException(error);
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
      throw const ApiException(
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue.',
        statusCode: 401,
      );
    }
    if (tokens.isRefreshExpired) {
      await tokenStore.clearIfCurrent(generation);
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
      throw _mapDioException(error);
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

  ApiException _mapDioException(DioException error) {
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

    return ApiException(
      code: 'API_ERROR',
      message: response?.statusMessage ?? 'Something went wrong.',
      statusCode: response?.statusCode,
    );
  }
}

class ServerSentEvent {
  const ServerSentEvent({required this.event, required this.data});

  final String event;
  final String data;
}

Stream<ServerSentEvent> _decodeServerSentEvents(
  Stream<List<int>> stream,
) async* {
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
  await for (final line
      in utf8.decoder.bind(stream).transform(const LineSplitter())) {
    if (line.isEmpty) {
      if (dataLines.isNotEmpty) {
        yield ServerSentEvent(event: event, data: dataLines.join('\n'));
      }
      reset();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }

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
  }

  if (dataLines.isNotEmpty) {
    yield ServerSentEvent(event: event, data: dataLines.join('\n'));
  }
}
