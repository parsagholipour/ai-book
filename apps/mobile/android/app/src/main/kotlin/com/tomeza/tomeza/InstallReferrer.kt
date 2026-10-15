package com.tomeza.tomeza

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * Reads the Play install referrer: the `referrer` query a Play Store link
 * carried when this install was started — a shared book's page puts
 * `utm_source=share&utm_content=<slug>` there (apps/api/src/mobile/shares/sharePage.ts).
 * Dart asks once per install (`lib/features/attribution/`).
 *
 * Every outcome answers exactly once, with a map whose `status` is `ok`
 * (and the referrer), `unsupported` (no Play Store, or one too old to say —
 * asking again will not help), `unavailable` (the Play service could not be
 * reached; worth one more try on a later launch) or `error`.
 */
fun registerInstallReferrer(context: Context, messenger: BinaryMessenger) {
  val appContext = context.applicationContext
  MethodChannel(messenger, "tomeza/install_referrer").setMethodCallHandler { call, result ->
    if (call.method != "read") {
      result.notImplemented()
      return@setMethodCallHandler
    }
    readInstallReferrer(appContext) { answer -> result.success(answer) }
  }
}

private fun readInstallReferrer(context: Context, reply: (Map<String, Any?>) -> Unit) {
  val main = Handler(Looper.getMainLooper())
  var answered = false
  var client: InstallReferrerClient? = null

  // The listener's callbacks, the worker thread and a disconnect can all try
  // to answer; only the first reaches Dart, on the main thread as the channel
  // requires, and the connection is closed behind it.
  fun answer(value: Map<String, Any?>) {
    main.post {
      if (answered) return@post
      answered = true
      try {
        client?.endConnection()
      } catch (error: Exception) {
        // Closing a connection that never opened is not news.
      }
      reply(value)
    }
  }

  val built =
    try {
      InstallReferrerClient.newBuilder(context).build()
    } catch (error: Exception) {
      answer(mapOf("status" to "error"))
      return
    }
  client = built
  try {
    built.startConnection(
      object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(responseCode: Int) {
          when (responseCode) {
            InstallReferrerClient.InstallReferrerResponse.OK ->
              // getInstallReferrer() is a call into the Play Store's process;
              // it is kept off the main thread.
              Thread {
                  try {
                    val details = built.installReferrer
                    answer(
                      mapOf(
                        "status" to "ok",
                        "referrer" to details.installReferrer,
                        "clickedAtSeconds" to details.referrerClickTimestampSeconds,
                        "installBeganAtSeconds" to details.installBeginTimestampSeconds,
                      )
                    )
                  } catch (error: Exception) {
                    answer(mapOf("status" to "unavailable"))
                  }
                }
                .start()
            InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED ->
              answer(mapOf("status" to "unsupported"))
            InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE ->
              answer(mapOf("status" to "unavailable"))
            else -> answer(mapOf("status" to "error"))
          }
        }

        override fun onInstallReferrerServiceDisconnected() {
          answer(mapOf("status" to "unavailable"))
        }
      }
    )
  } catch (error: Exception) {
    answer(mapOf("status" to "error"))
  }
}
