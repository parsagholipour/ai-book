import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:pdfrx/pdfrx.dart';

import 'app/app.dart';
import 'features/app_update/data/app_update_repository.dart';
import 'features/app_update/domain/app_update.dart';
import 'features/notifications/data/push_messaging.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Loads the PDF rendering engine the in-app book reader draws with.
  pdfrxFlutterInitialize();
  // Claims the media session up front so audiobook playback can survive the app
  // going to the background. This has to happen before any player is built.
  await JustAudioBackground.init(
    androidNotificationChannelId: 'com.tomeza.tomeza.audiobook',
    androidNotificationChannelName: 'Audiobook playback',
    androidNotificationOngoing: true,
    androidStopForegroundOnPause: true,
  );
  // Read before the first request: every request names this build, which is
  // what lets the server retire it (see `AppBuild`).
  final build = await readAppBuild();
  // Book-progress and book-ready notifications. Null in a build made without
  // google-services.json, and the app then simply never offers them.
  final pushMessaging = await FirebasePushMessaging.initialize();
  runApp(
    ProviderScope(
      overrides: [
        appBuildProvider.overrideWithValue(build),
        if (pushMessaging != null)
          pushMessagingProvider.overrideWithValue(pushMessaging),
      ],
      child: const TomezaApp(),
    ),
  );
}
