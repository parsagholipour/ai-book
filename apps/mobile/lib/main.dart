import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:pdfrx/pdfrx.dart';

import 'app/app.dart';
import 'app/launch/app_startup.dart';
import 'app/launch/font_licenses.dart';
import 'app/routing/app_router.dart';
import 'features/app_update/data/app_update_repository.dart';
import 'features/app_update/domain/app_update.dart';
import 'features/notifications/data/push_messaging.dart';
import 'shared/diagnostics/crash_reporting.dart';
import 'shared/lifecycle/app_resume_signal.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // The bundled fonts' OFL text, shown on the Licences page.
  registerFontLicenses();
  // Lets providers (the book status watch) hear the app come back.
  AppResumeSignal.start();
  runApp(
    AppStartup(
      initialize: _initializeApp,
      builder: (services, initialLocation) => ProviderScope(
        overrides: [
          initialAppLocationProvider.overrideWithValue(initialLocation),
          appBuildProvider.overrideWithValue(services.build),
          if (services.pushMessaging case final messaging?)
            pushMessagingProvider.overrideWithValue(messaging),
        ],
        child: const TomezaApp(),
      ),
    ),
  );
}

Future<({AppBuild? build, PushMessaging? pushMessaging})>
_initializeApp() async {
  // Install error handlers before the PDF/audio plugins or any other startup
  // work can fail. Push notifications reuse the same default Firebase app.
  await initializeCrashReporting();
  // Loads the PDF rendering engine the in-app book reader draws with.
  pdfrxFlutterInitialize();
  // Claims the media session up front so audiobook playback can survive the app
  // going to the background. This has to happen before any player is built.
  await JustAudioBackground.init(
    androidNotificationChannelId: 'com.tomeza.tomeza.audiobook',
    androidNotificationChannelName: 'Audiobook playback',
    androidNotificationOngoing: true,
    androidStopForegroundOnPause: true,
    // The monochrome status-bar icon; the default is the full-colour launcher
    // icon, a white square on older Android. `res/raw/tomeza_keep.xml` keeps
    // it in release, where it is named only by this string.
    androidNotificationIcon: 'drawable/ic_stat_tomeza',
  );
  // Read before the first request: every request names this build, which is
  // what lets the server retire it (see `AppBuild`).
  final build = await readAppBuild();
  // Book-progress and book-ready notifications. Null in a build made without
  // google-services.json, and the app then simply never offers them.
  final pushMessaging = await FirebasePushMessaging.initialize();
  return (build: build, pushMessaging: pushMessaging);
}
