import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/plan_revision_retry.dart';

void main() {
  test('each plan revision recovery attempt gets a distinct command ID', () {
    final first = createPlanRevisionRetryRequestId('operation-1');
    final second = createPlanRevisionRetryRequestId('operation-1');

    expect(first, startsWith('retry-operation-1-'));
    expect(second, startsWith('retry-operation-1-'));
    expect(second, isNot(first));
    expect(first, isNot('revision-original-request'));
  });
}
