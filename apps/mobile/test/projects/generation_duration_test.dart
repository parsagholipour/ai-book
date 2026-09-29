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

  test('says when an automatic retry runs, never sooner than it will', () {
    final now = DateTime.utc(2026, 6, 15, 12);
    expect(formatRetryCountdown(null, now), 'Trying again shortly.');
    expect(
      formatRetryCountdown(now.subtract(const Duration(minutes: 1)), now),
      'Trying again now.',
    );
    expect(
      formatRetryCountdown(now.add(const Duration(seconds: 30)), now),
      'Trying again in under a minute.',
    );
    expect(
      formatRetryCountdown(now.add(const Duration(seconds: 61)), now),
      'Trying again in about 2 min.',
    );
    expect(
      formatRetryCountdown(now.add(const Duration(minutes: 90)), now),
      'Trying again in about 2 h.',
    );
  });

  test(
    'sums a finished book up in one line, dropping what it does not know',
    () {
      expect(
        finishedBookSummary(pages: 10, images: 3, durationMs: 473000),
        'Ready · 10 pages · 3 images · made in 7m 53s',
      );
      expect(
        finishedBookSummary(pages: 1, images: 1),
        'Ready · 1 page · 1 image',
      );
      expect(finishedBookSummary(pages: 0, images: 0), 'Ready');
    },
  );
}
