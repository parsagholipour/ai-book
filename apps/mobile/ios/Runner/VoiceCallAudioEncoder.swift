import AVFoundation
import Flutter

/// Turns a finished call's raw PCM spool into an `.m4a` the caller can share.
///
/// Kept off `VoiceCallAudioPlayer`'s channel on purpose: that one is the live
/// audio path, while this runs once, on a background queue, over audio that has
/// already been captured. `AVAudioFile` writes through its own converter and
/// never touches the shared `AVAudioSession`, so encoding mid-call cannot
/// disturb the call it is encoding.
class VoiceCallAudioEncoder: NSObject {
  static let channelName = "tomeza/voice_call_recorder"

  /// Frames per write. Large enough to keep the converter fed, small enough
  /// that a long call never holds the whole recording in memory.
  private static let framesPerBuffer: AVAudioFrameCount = 4096
  private static let bytesPerSample = 2

  private let queue = DispatchQueue(label: "tomeza.voice-call-encoder", qos: .userInitiated)

  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
    let encoder = VoiceCallAudioEncoder()
    channel.setMethodCallHandler { call, result in
      encoder.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard call.method == "encodeAac" else {
      result(FlutterMethodNotImplemented)
      return
    }
    guard
      let arguments = call.arguments as? [String: Any],
      let pcmPath = arguments["pcmPath"] as? String,
      let outputPath = arguments["outputPath"] as? String
    else {
      result(
        FlutterError(
          code: "invalid_arguments",
          message: "A source and a destination path are required.",
          details: nil
        )
      )
      return
    }
    let sampleRate = arguments["sampleRate"] as? Int ?? 24000
    let bitrate = arguments["bitrate"] as? Int ?? 32000

    queue.async {
      do {
        try self.encode(
          source: URL(fileURLWithPath: pcmPath),
          destination: URL(fileURLWithPath: outputPath),
          sampleRate: Double(sampleRate),
          bitrate: bitrate
        )
        DispatchQueue.main.async { result(nil) }
      } catch {
        DispatchQueue.main.async {
          result(
            FlutterError(
              code: "encode_failed",
              message: error.localizedDescription,
              details: nil
            )
          )
        }
      }
    }
  }

  private func encode(source: URL, destination: URL, sampleRate: Double, bitrate: Int) throws {
    let handle = try FileHandle(forReadingFrom: source)
    defer { try? handle.close() }

    let manager = FileManager.default
    try manager.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    if manager.fileExists(atPath: destination.path) {
      try manager.removeItem(at: destination)
    }

    // The spool is interleaved 16-bit little-endian mono, which is exactly what
    // `AVAudioFile` reads when it is handed a matching processing format; the
    // AAC conversion is then its own business.
    guard
      let readFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: true
      )
    else {
      throw EncodeError.unsupportedFormat
    }

    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: bitrate
    ]
    let file = try AVAudioFile(
      forWriting: destination,
      settings: settings,
      commonFormat: .pcmFormatInt16,
      interleaved: true
    )

    let bytesPerFrame = Self.bytesPerSample
    let chunkBytes = Int(Self.framesPerBuffer) * bytesPerFrame
    var wroteAnything = false

    while true {
      let data = try handle.read(upToCount: chunkBytes) ?? Data()
      if data.isEmpty {
        break
      }
      let frames = AVAudioFrameCount(data.count / bytesPerFrame)
      if frames == 0 {
        break
      }
      guard let buffer = AVAudioPCMBuffer(pcmFormat: readFormat, frameCapacity: frames) else {
        throw EncodeError.unsupportedFormat
      }
      buffer.frameLength = frames
      guard let channel = buffer.int16ChannelData?[0] else {
        throw EncodeError.unsupportedFormat
      }
      data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        // The spool is little-endian and so is every device this ships to, so
        // the frames go straight across without a byte swap.
        channel.withMemoryRebound(to: UInt8.self, capacity: Int(frames) * bytesPerFrame) { bytes in
          bytes.update(from: base.assumingMemoryBound(to: UInt8.self), count: Int(frames) * bytesPerFrame)
        }
      }
      try file.write(from: buffer)
      wroteAnything = true
    }

    if !wroteAnything {
      throw EncodeError.emptyRecording
    }
  }

  private enum EncodeError: LocalizedError {
    case unsupportedFormat
    case emptyRecording

    var errorDescription: String? {
      switch self {
      case .unsupportedFormat:
        return "This device cannot encode the recording."
      case .emptyRecording:
        return "There is nothing recorded to encode."
      }
    }
  }
}
