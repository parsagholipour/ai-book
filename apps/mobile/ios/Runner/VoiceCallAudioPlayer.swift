import AVFoundation
import Flutter

/// Speaker side of a character voice call.
///
/// Two things here matter more than the playback itself. The session is put in
/// `.voiceChat` mode, which switches the shared audio session onto the system's
/// voice-processing I/O — that is what cancels the character's own voice out of
/// the microphone the `record` plugin is reading, so Gemini's turn detection
/// does not interrupt the character mid-sentence. And `.playAndRecord` keeps the
/// call on the call volume rocker rather than the media one.
///
/// The session is shared with the recorder, so this deliberately configures it
/// rather than building its own: two owners fighting over the category is how
/// you get a call that plays through the earpiece at 10% volume.
final class VoiceCallAudioPlayer: NSObject {
  static let channelName = "tomeza/voice_call_audio"

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var format: AVAudioFormat?
  private var running = false

  static func register(with messenger: FlutterBinaryMessenger) {
    let instance = VoiceCallAudioPlayer()
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      instance.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "start":
      start(sampleRate: arguments["sampleRate"] as? Int ?? 24000,
            speakerphone: arguments["speakerphone"] as? Bool ?? true,
            result: result)
    case "write":
      write(bytes: arguments["bytes"] as? FlutterStandardTypedData, result: result)
    case "flush":
      flush()
      result(nil)
    case "setSpeakerphone":
      applySpeakerphone(arguments["enabled"] as? Bool ?? true)
      result(nil)
    case "stop":
      stop()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func start(sampleRate: Int, speakerphone: Bool, result: @escaping FlutterResult) {
    stop()
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
      )
      try session.setActive(true, options: [])
      applySpeakerphone(speakerphone)

      guard let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Double(sampleRate),
        channels: 1,
        interleaved: true
      ) else {
        result(FlutterError(code: "unsupported",
                            message: "This device cannot play \(sampleRate) Hz mono PCM.",
                            details: nil))
        return
      }
      self.format = format

      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      engine.prepare()
      try engine.start()
      player.play()
      running = true
      result(nil)
    } catch {
      result(FlutterError(code: "audio_session",
                          message: error.localizedDescription,
                          details: nil))
    }
  }

  private func write(bytes: FlutterStandardTypedData?, result: @escaping FlutterResult) {
    guard running, let format, let data = bytes?.data, !data.isEmpty else {
      result(false)
      return
    }
    let frameCount = AVAudioFrameCount(data.count / 2)
    guard frameCount > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
          let channel = buffer.int16ChannelData else {
      result(false)
      return
    }
    buffer.frameLength = frameCount
    data.withUnsafeBytes { raw in
      guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
      channel[0].update(from: base, count: Int(frameCount))
    }
    player.scheduleBuffer(buffer, completionHandler: nil)
    result(true)
  }

  /// Drops audio that has not been heard yet, so talking over the character
  /// actually cuts them off instead of queueing behind their finished reply.
  private func flush() {
    guard running else { return }
    player.stop()
    player.play()
  }

  private func applySpeakerphone(_ enabled: Bool) {
    let session = AVAudioSession.sharedInstance()
    try? session.overrideOutputAudioPort(enabled ? .speaker : .none)
  }

  private func stop() {
    if running {
      player.stop()
      engine.stop()
      engine.detach(player)
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
    format = nil
    running = false
  }
}
