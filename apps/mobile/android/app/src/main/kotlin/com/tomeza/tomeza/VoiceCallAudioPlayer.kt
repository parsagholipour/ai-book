package com.tomeza.tomeza

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodChannel.MethodCallHandler
import io.flutter.plugin.common.MethodChannel.Result
import java.util.concurrent.LinkedBlockingQueue

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
 *
 * The track is owned by one writer thread per call, never the main thread. A
 * method channel handler runs on Android's main thread, which is also Dart's,
 * and Gemini streams a reply faster than realtime: a write that waits for room
 * in the track froze the app for the length of every reply. The mic chunks
 * queued behind it reached the relay in one burst, past its audio rate limit,
 * and the relay ended the call after the character's first answer.
 */
class VoiceCallAudioPlayer(private val audioManager: AudioManager?) : MethodCallHandler {
  companion object {
    const val CHANNEL = "tomeza/voice_call_audio"
    /** Enough slack to ride out a stalled socket without adding audible delay. */
    private const val BUFFER_MULTIPLIER = 4
    /** How long the writer waits for room in a full track before trying again. */
    private const val FULL_TRACK_WAIT_MS = 10L
  }

  private sealed interface Command {
    class Write(val generation: Int, val bytes: ByteArray) : Command
    object Flush : Command
    object Stop : Command
  }

  private class Writer(val track: AudioTrack) {
    val commands = LinkedBlockingQueue<Command>()
    /** Bumped by a flush or stop, so every write queued before it is skipped. */
    @Volatile var generation = 0
    val thread = Thread({ run() }, "voice-call-playback")

    private fun run() {
      while (true) {
        when (val command = commands.take()) {
          is Command.Write -> play(command)
          Command.Flush -> {
            track.pause()
            track.flush()
            track.play()
          }
          Command.Stop -> {
            runCatching { track.pause() }
            runCatching { track.flush() }
            runCatching { track.stop() }
            track.release()
            return
          }
        }
      }
    }

    // Non-blocking writes, retried while the track is full: a blocking one could
    // not notice a flush until the track had room, and dropping what did not fit
    // would cut the tail off every long reply.
    private fun play(command: Command.Write) {
      var offset = 0
      while (offset < command.bytes.size && command.generation == generation) {
        val written = track.write(command.bytes, offset, command.bytes.size - offset, AudioTrack.WRITE_NON_BLOCKING)
        if (written < 0) return
        offset += written
        if (offset < command.bytes.size) Thread.sleep(FULL_TRACK_WAIT_MS)
      }
    }
  }

  private var writer: Writer? = null
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

    val track = AudioTrack.Builder()
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
    track.play()
    writer = Writer(track).also { it.thread.start() }
    result.success(null)
  }

  /** Queues the audio and answers at once; the writer paces it into the track. */
  private fun write(call: MethodCall, result: Result) {
    val bytes = call.argument<ByteArray>("bytes")
    val active = writer
    if (bytes == null || active == null) {
      result.success(false)
      return
    }
    active.commands.put(Command.Write(active.generation, bytes))
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
    writer?.let { active ->
      active.generation += 1
      active.commands.put(Command.Flush)
    }
  }

  private fun stop() {
    writer?.let { active ->
      active.generation += 1
      active.commands.put(Command.Stop)
      // The writer skips what is queued and is never blocked inside the track,
      // so this is a few milliseconds; the bound only keeps a wedged device from
      // hanging the main thread.
      active.thread.join(500)
    }
    writer = null
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
