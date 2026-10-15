import 'package:flutter_riverpod/misc.dart' show ProviderException;

class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.statusCode,
    this.details = const <String, dynamic>{},
    this.retryAfter,
  });

  final String code;
  final String message;
  final int? statusCode;

  /// Whatever else the error body carried beside its code and message — the
  /// credits a 402 was short of, the image quota a 403 hit. Refusals the app can
  /// act on say so in numbers, and the message alone throws them away.
  final Map<String, dynamic> details;

  /// How long the server asked the client to wait, from a `Retry-After`
  /// header given in seconds (what `sendRateLimitError` writes on every 429).
  /// Null when the response named no wait.
  final Duration? retryAfter;

  bool get isAuthFailure {
    return statusCode == 401 ||
        statusCode == 403 ||
        code == 'AUTH_REQUIRED' ||
        code == 'INVALID_SESSION';
  }

  @override
  String toString() => message;
}

String userFacingError(Object error) {
  // Riverpod 3 rethrows a provider's failure wrapped, whenever a provider in
  // error state is read — `ref.read(billingProvider.future)` included — so the
  // server's own sentence is one layer down.
  if (error is ProviderException) {
    return userFacingError(error.exception);
  }
  if (error is ApiException) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
