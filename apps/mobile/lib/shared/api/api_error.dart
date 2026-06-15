class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.statusCode,
  });

  final String code;
  final String message;
  final int? statusCode;

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
