import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let messenger = engineBridge.pluginRegistry
      .registrar(forPlugin: "VoiceCallAudioPlayer")?.messenger() {
      VoiceCallAudioPlayer.register(with: messenger)
    }
    if let messenger = engineBridge.pluginRegistry
      .registrar(forPlugin: "VoiceCallAudioEncoder")?.messenger() {
      VoiceCallAudioEncoder.register(with: messenger)
    }
  }
}
