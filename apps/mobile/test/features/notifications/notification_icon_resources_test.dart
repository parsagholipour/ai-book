import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notifications/data/book_notification_presenter.dart';

/// The notification icon is named only by a Dart string, which the release
/// resource shrinker cannot read. Unless the keep file names it, release builds
/// strip the drawable and flutter_local_notifications refuses to initialize
/// ("invalid_icon"), which turns push notifications off for the whole app.
void main() {
  const res = 'android/app/src/main/res';

  test('the book notification icon exists as a drawable at every density', () {
    for (final density in ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      expect(
        File('$res/drawable-$density/$bookNotificationIcon.png').existsSync(),
        isTrue,
        reason: 'drawable-$density/$bookNotificationIcon.png is missing',
      );
    }
  });

  test('the release resource shrinker is told to keep the notification icon', () {
    final keep = File('$res/raw/tomeza_keep.xml').readAsStringSync();
    expect(keep, contains('@drawable/$bookNotificationIcon'));
  });
}
