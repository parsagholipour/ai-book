import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:pdfrx/pdfrx.dart';

import 'app/app.dart';

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
  runApp(const ProviderScope(child: TomezaApp()));
}
