import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

/// A 429 names its wait only in the `Retry-After` header
/// (`sendRateLimitError` on the server); the body says "Try again soon." So
/// the header has to survive into the error, or the verify screen's resend
/// is refused again on every tap.
void main() {
  test('a 429 carries the Retry-After seconds into the error', () async {
    final client = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = _RateLimitedAdapter(retryAfter: '42'),
      tokenStore: MemoryAuthTokenStore(),
    );

    final error = await client
        .postMap('/api/mobile/auth/email/verification', requiresAuth: false)
        .then<Object?>((_) => null, onError: (Object error) => error);

    expect(error, isA<ApiException>());
    final refusal = error! as ApiException;
    expect(refusal.statusCode, 429);
    expect(refusal.code, 'RATE_LIMITED');
    expect(refusal.retryAfter, const Duration(seconds: 42));
  });

  test('only delta-seconds are read as a wait', () {
    expect(retryAfterFromHeader('125'), const Duration(seconds: 125));
    expect(retryAfterFromHeader(' 0 '), Duration.zero);
    expect(retryAfterFromHeader(null), isNull);
    expect(retryAfterFromHeader('-3'), isNull);
    expect(retryAfterFromHeader('Wed, 21 Oct 2026 07:28:00 GMT'), isNull);
  });
}

class _RateLimitedAdapter implements HttpClientAdapter {
  _RateLimitedAdapter({required this.retryAfter});

  final String retryAfter;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    return ResponseBody.fromString(
      '{"error":{"code":"RATE_LIMITED","message":"Too many attempts. Try again soon."}}',
      429,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
        'retry-after': [retryAfter],
      },
    );
  }
}
