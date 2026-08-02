package com.tomeza.tomeza

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import java.io.File
import java.util.concurrent.Executors

/**
 * Turns a finished call's raw PCM spool into an `.m4a` the caller can share.
 *
 * Separate from [VoiceCallAudioPlayer] and its channel: that one is the live
 * audio path and has to stay responsive for the length of a call, while this
 * runs once, off the main thread, after the audio it encodes has already been
 * captured. Nothing here touches the audio session.
 *
 * `MediaCodec` rather than a bundled encoder because the platform already ships
 * one — the app is not carrying an encoder binary for a file most calls never
 * ask for.
 */
class VoiceCallAudioEncoder : MethodCallHandler {
  companion object {
    const val CHANNEL = "tomeza/voice_call_recorder"
    private const val MIME_TYPE = MediaFormat.MIMETYPE_AUDIO_AAC
    private const val BYTES_PER_SAMPLE = 2

    /** Comfortably larger than one AAC frame of mono 16-bit audio. */
    private const val READ_BUFFER_BYTES = 8192
    private const val DEQUEUE_TIMEOUT_US = 10_000L
  }

  private val worker = Executors.newSingleThreadExecutor()

  override fun onMethodCall(call: MethodCall, result: Result) {
    when (call.method) {
      "encodeAac" -> {
        val pcmPath = call.argument<String>("pcmPath")
        val outputPath = call.argument<String>("outputPath")
        val sampleRate = call.argument<Int>("sampleRate") ?: 24000
        val bitrate = call.argument<Int>("bitrate") ?: 32000
        if (pcmPath == null || outputPath == null) {
          result.error("invalid_arguments", "A source and a destination path are required.", null)
          return
        }
        // Answered on the platform thread, but encoded off it: half an hour of
        // audio is seconds of work, and blocking here would freeze the UI that
        // is showing the caller a spinner.
        worker.execute {
          val outcome = runCatching { encode(File(pcmPath), File(outputPath), sampleRate, bitrate) }
          Handler(Looper.getMainLooper()).post {
            outcome
              .onSuccess { result.success(null) }
              .onFailure { error ->
                result.error("encode_failed", error.message ?: "The recording could not be encoded.", null)
              }
          }
        }
      }
      else -> result.notImplemented()
    }
  }

  private fun encode(source: File, destination: File, sampleRate: Int, bitrate: Int) {
    if (!source.isFile || source.length() <= 0) {
      throw IllegalStateException("There is nothing recorded to encode.")
    }
    destination.parentFile?.mkdirs()
    if (destination.exists()) {
      destination.delete()
    }

    val format = MediaFormat.createAudioFormat(MIME_TYPE, sampleRate, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, READ_BUFFER_BYTES)
    }

    val codec = MediaCodec.createEncoderByType(MIME_TYPE)
    val muxer = MediaMuxer(destination.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var trackIndex = -1
    var muxing = false

    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()

      val info = MediaCodec.BufferInfo()
      val buffer = ByteArray(READ_BUFFER_BYTES)
      var totalSamples = 0L
      var sourceDrained = false

      source.inputStream().buffered().use { input ->
        while (true) {
          if (!sourceDrained) {
            val inputIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            if (inputIndex >= 0) {
              val read = input.read(buffer)
              val inputBuffer = codec.getInputBuffer(inputIndex)
              if (read <= 0) {
                codec.queueInputBuffer(inputIndex, 0, 0, presentationTimeUs(totalSamples, sampleRate), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                sourceDrained = true
              } else {
                inputBuffer?.clear()
                inputBuffer?.put(buffer, 0, read)
                // Timestamps are derived from the sample count rather than the
                // clock: the whole file is encoded as fast as it can be read,
                // so wall time here has nothing to do with playback time.
                codec.queueInputBuffer(inputIndex, 0, read, presentationTimeUs(totalSamples, sampleRate), 0)
                totalSamples += read / BYTES_PER_SAMPLE
              }
            }
          }

          val outputIndex = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
          when {
            outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              trackIndex = muxer.addTrack(codec.outputFormat)
              muxer.start()
              muxing = true
            }
            outputIndex >= 0 -> {
              val encoded = codec.getOutputBuffer(outputIndex)
              // Codec config lands in the track format, not in the stream.
              if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                info.size = 0
              }
              if (info.size > 0 && encoded != null && muxing) {
                encoded.position(info.offset)
                encoded.limit(info.offset + info.size)
                muxer.writeSampleData(trackIndex, encoded, info)
              }
              codec.releaseOutputBuffer(outputIndex, false)
              if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                return@use
              }
            }
          }
        }
      }
    } finally {
      runCatching { codec.stop() }
      runCatching { codec.release() }
      if (muxing) {
        runCatching { muxer.stop() }
      }
      runCatching { muxer.release() }
    }

    if (!destination.isFile || destination.length() <= 0) {
      throw IllegalStateException("The recording could not be encoded.")
    }
  }

  private fun presentationTimeUs(samples: Long, sampleRate: Int): Long =
    samples * 1_000_000L / sampleRate
}

fun registerVoiceCallAudioEncoder(messenger: BinaryMessenger) {
  MethodChannel(messenger, VoiceCallAudioEncoder.CHANNEL)
    .setMethodCallHandler(VoiceCallAudioEncoder())
}
