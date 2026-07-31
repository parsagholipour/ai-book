package com.tomeza.tomeza

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result

/**
 * Speaker side of a character voice call.
 *
 * Off-the-shelf PCM playback plugins render on `USAGE_MEDIA`, which is wrong
 * here in two ways: the volume rocker would change the media volume rather than
 * the call volume mid-call, and — the expensive one — audio on the media path is
 * not part of the reference signal the platform echo canceller subtracts from
 * the microphone. The recorder is running in `MODE_IN_COMMUNICATION` with the
 * `VOICE_COMMUNICATION` source, so playing the character back on
 * `USAGE_VOICE_COMMUNICATION` is what stops Gemini from hearing its own voice
 * and interrupting itself mid-sentence.
 */
class VoiceCallAudioPlayer(private val audioManager: AudioManager?) : MethodCallHandler {
  companion object {
    const val CHANNEL = "tomeza/voice_call_audio"
    /** Enough slack to ride out a stalled socket without adding audible delay. */
    private const val BUFFER_MULTIPLIER = 4
  }

  private var track: AudioTrack? = null
  private var previousMode: Int? = null
  private var previousSpeakerphone: Boolean? = null

  override fun onMethodCall(call: MethodCall, result: Result) {
    when (call.method) {
      "start" -> start(call, result)
      "write" -> write(call, result)
      "flush" -> {
        flush()
        result.success(null)
      }
      "setSpeakerphone" -> {
        audioManager?.isSpeakerphoneOn = call.argument<Boolean>("enabled") ?: true
        result.success(null)
      }
      "stop" -> {
        stop()
        result.success(null)
      }
      else -> result.notImplemented()
    }
  }

  private fun start(call: MethodCall, result: Result) {
    stop()
    val sampleRate = call.argument<Int>("sampleRate") ?: 24000
    val minBufferBytes = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBufferBytes <= 0) {
      result.error("unsupported", "This device cannot play $sampleRate Hz mono PCM.", null)
      return
    }

    audioManager?.let { manager ->
      previousMode = manager.mode
      previousSpeakerphone = manager.isSpeakerphoneOn
      manager.mode = AudioManager.MODE_IN_COMMUNICATION
      manager.isSpeakerphoneOn = call.argument<Boolean>("speakerphone") ?: true
    }

    track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setBufferSizeInBytes(minBufferBytes * BUFFER_MULTIPLIER)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
      .also { it.play() }
    result.success(null)
  }

  private fun write(call: MethodCall, result: Result) {
    val bytes = call.argument<ByteArray>("bytes")
    val active = track
    if (bytes == null || active == null) {
      result.success(false)
      return
    }
    // Blocking writes let AudioTrack's own buffer pace playback. Gemini streams
    // faster than realtime, so a non-blocking write would drop the tail of every
    // long reply once the buffer filled.
    active.write(bytes, 0, bytes.size, AudioTrack.WRITE_BLOCKING)
    result.success(true)
  }

  /**
   * Drops audio that has not been heard yet.
   *
   * Called when the caller talks over the character: everything already queued
   * is a reply to something the user has moved on from, and playing it out would
   * make the interruption feel ignored.
   */
  private fun flush() {
    track?.let { active ->
      active.pause()
      active.flush()
      active.play()
    }
  }

  private fun stop() {
    track?.let { active ->
      runCatching { active.pause() }
      runCatching { active.flush() }
      runCatching { active.stop() }
      active.release()
    }
    track = null
    audioManager?.let { manager ->
      previousMode?.let { manager.mode = it }
      previousSpeakerphone?.let { manager.isSpeakerphoneOn = it }
    }
    previousMode = null
    previousSpeakerphone = null
  }
}

fun registerVoiceCallAudioPlayer(activity: MainActivity, messenger: io.flutter.plugin.common.BinaryMessenger) {
  val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as? AudioManager
  MethodChannel(messenger, VoiceCallAudioPlayer.CHANNEL)
    .setMethodCallHandler(VoiceCallAudioPlayer(audioManager))
}
