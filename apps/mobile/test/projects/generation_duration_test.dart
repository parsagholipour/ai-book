import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/generation_duration.dart';

void main() {
  test('formats completed stage durations', () {
    expect(formatGenerationDuration(null), isNull);
    expect(formatGenerationDuration(54 * 1000), '54s');
    expect(formatGenerationDuration(72 * 1000), '1m 12s');
    expect(formatGenerationDuration(8 * 60 * 1000), '8m');
    expect(formatGenerationDuration(61 * 60 * 1000), '1h 1m');
  });
}
