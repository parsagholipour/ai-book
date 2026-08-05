class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.statusCode,
    this.details = const <String, dynamic>{},
  });

  final String code;
  final String message;
  final int? statusCode;

  /// Whatever else the error body carried beside its code and message — the
  /// credits a 402 was short of, the image quota a 403 hit. Refusals the app can
  /// act on say so in numbers, and the message alone throws them away.
  final Map<String, dynamic> details;

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
  if (error is ApiException) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
