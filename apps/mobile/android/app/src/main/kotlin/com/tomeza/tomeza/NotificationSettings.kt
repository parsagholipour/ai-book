package com.tomeza.tomeza

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * Opens Tomeza's page in the system notification settings — the only place a
 * reader who refused notifications can turn them back on, since Android 13+
 * shows its permission prompt once. Below API 26 there is no per-app
 * notification page, so the app's details page stands in.
 */
fun registerNotificationSettings(context: Context, messenger: BinaryMessenger) {
  val appContext = context.applicationContext
  MethodChannel(messenger, "tomeza/notification_settings").setMethodCallHandler { call, result ->
    if (call.method != "open") {
      result.notImplemented()
      return@setMethodCallHandler
    }
    val intent =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, appContext.packageName)
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.fromParts("package", appContext.packageName, null))
      }
    try {
      appContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      result.success(true)
    } catch (error: Exception) {
      result.success(false)
    }
  }
}
