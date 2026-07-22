int _retryRequestSequence = 0;

/// Creates an idempotency key for one recovery attempt.
///
/// This must not reuse the original revision request ID: the server persists
/// the last successful retry command and treats that ID as a replay.
String createPlanRevisionRetryRequestId(String operationId) {
  _retryRequestSequence += 1;
  return 'retry-$operationId-${DateTime.now().microsecondsSinceEpoch}-$_retryRequestSequence';
}
