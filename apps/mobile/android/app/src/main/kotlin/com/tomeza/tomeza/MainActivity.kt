package com.tomeza.tomeza

import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine

// AudioServiceActivity, not FlutterActivity: audio_service hosts the app in one
// cached FlutterEngine that outlives the activity, which is what keeps audiobook
// playback going once the UI is gone. A plain FlutterActivity brings its own
// engine, so the plugin spawns a second one and then throws "The Activity class
// declared in your AndroidManifest.xml is wrong" out of JustAudioBackground.init.
class MainActivity : AudioServiceActivity() {
  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    registerVoiceCallAudioPlayer(this, flutterEngine.dartExecutor.binaryMessenger)
  }
}
