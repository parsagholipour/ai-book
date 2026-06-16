import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/config/app_config.dart';
import '../../features/auth/domain/auth_models.dart';
import 'api_error.dart';
import 'auth_token_store.dart';

final dioProvider = Provider<Dio>((ref) {
  final config = ref.watch(appConfigProvider);
  return Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl.toString(),
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 20),
      headers: const {'Accept': 'application/json'},
    ),
  );
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    dio: ref.watch(dioProvider),
    tokenStore: ref.watch(authTokenStoreProvider),
  );
});

class ApiClient {
  ApiClient({required this.dio, required this.tokenStore});

  final Dio dio;
  final AuthTokenStore tokenStore;

  Future<Response<dynamic>> getJson(String path, {bool requiresAuth = true}) {
    return _request('GET', path, requiresAuth: requiresAuth);
  }

  Future<Map<String, String>> authHeaders() async {
    final accessToken = await _validAccessToken();
    return {'Authorization': 'Bearer $accessToken'};
  }

  Future<Response<dynamic>> postJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _request('POST', path, data: data, requiresAuth: requiresAuth);
  }

  Future<Response<dynamic>> patchJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _request('PATCH', path, data: data, requiresAuth: requiresAuth);
  }

  Future<Response<dynamic>> deleteJson(
    String path, {
    Object? data,
    bool requiresAuth = true,
  }) {
    return _request('DELETE', path, data: data, requiresAuth: requiresAuth);
  }

  Future<void> downloadFile(String path, String savePath) async {
    final accessToken = await _validAccessToken();
    try {
      await dio.download(
        path,
        savePath,
        options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
      );
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) {
        final tokens = await refreshTokens();
        await dio.download(
          path,
          savePath,
          options: Options(
            headers: {'Authorization': 'Bearer ${tokens.accessToken}'},
          ),
        );
        return;
      }
      throw _mapDioException(error);
    }
  }

  Future<MobileSessionTokens> refreshTokens() async {
    final current = await tokenStore.read();
    if (current == null || current.isRefreshExpired) {
      await tokenStore.clear();
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
      final data = response.data as Map<String, dynamic>;
      final tokens = MobileSessionTokens.fromJson(
        data['session'] as Map<String, dynamic>,
      );
      await tokenStore.write(tokens);
      return tokens;
    } on DioException catch (error) {
      final mapped = _mapDioException(error);
      if (mapped.isAuthFailure) {
        await tokenStore.clear();
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
  }) async {
    final options = Options(
      method: method,
      contentType: data == null ? null : Headers.jsonContentType,
    );
    if (requiresAuth) {
      final accessToken = await _validAccessToken();
      options.headers = {'Authorization': 'Bearer $accessToken'};
    }

    try {
      return await dio.request<dynamic>(path, data: data, options: options);
    } on DioException catch (error) {
      if (requiresAuth &&
          retryOnAuthFailure &&
          error.response?.statusCode == 401) {
        final tokens = await refreshTokens();
        return dio.request<dynamic>(
          path,
          data: data,
          options: Options(
            method: method,
            contentType: data == null ? null : Headers.jsonContentType,
            headers: {'Authorization': 'Bearer ${tokens.accessToken}'},
          ),
        );
      }
      throw _mapDioException(error);
    }
  }

  Future<String> _validAccessToken() async {
    final tokens = await tokenStore.read();
    if (tokens == null) {
      throw const ApiException(
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue.',
        statusCode: 401,
      );
    }
    if (tokens.isRefreshExpired) {
      await tokenStore.clear();
      throw const ApiException(
        code: 'SESSION_EXPIRED',
        message: 'Sign in again to continue.',
        statusCode: 401,
      );
    }
    if (tokens.shouldRefreshAccessToken) {
      return (await refreshTokens()).accessToken;
    }
    return tokens.accessToken;
  }

  ApiException _mapDioException(DioException error) {
    final response = error.response;
    final data = response?.data;
    if (data is Map<String, dynamic>) {
      final errorBody = data['error'];
      if (errorBody is Map<String, dynamic>) {
        return ApiException(
          code: errorBody['code'] as String? ?? 'API_ERROR',
          message: errorBody['message'] as String? ?? 'Something went wrong.',
          statusCode: response?.statusCode,
        );
      }
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
