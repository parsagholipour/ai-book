import 'dart:async';
import 'dart:io';
import 'dart:ui';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/book_push.dart';
import 'book_notification_presenter.dart';

enum PushPermission {
  granted,

  /// Refused, or turned off in the phone's settings. Only the settings page
  /// can change it now: Android stops showing the prompt after a refusal.
  denied,

  /// Never asked. On Android 13+ the system reports this as "denied" too, so
  /// the app keeps its own note of having asked.
  notAsked,
}

/// Firebase Cloud Messaging and the notification plugin, as the app needs
/// them. Behind an interface so the shell and its tests never touch a
/// platform channel: [pushMessagingProvider] is null in tests, on the web,
/// and in any build made without `google-services.json`.
abstract interface class PushMessaging {
  Future<PushPermission> permission();

  /// The system prompt (Android 13+, iOS). Recorded as asked whatever the
  /// answer: Android will not show it a second time anyway.
  Future<PushPermission> requestPermission();

  /// Whether the app's own offer (`offerBookNotifications`) was shown, and
  /// recording that it was — apart from the system prompt, so a reader who
  /// said "Not now" to the offer can still be shown the prompt from Account.
  Future<bool> wasOffered();
  Future<void> markOffered();

  /// This install's FCM token, or null when Firebase cannot issue one (no
  /// Play services, no network on first launch).
  Future<String?> token();

  String get platform;

  Stream<String> get tokenRefreshes;

  /// Books whose notification was tapped while the app was running.
  Stream<String> get openedBooks;

  /// The book whose notification launched the app, once per process.
  Future<String?> takeLaunchBook();

  /// This app's page in the system notification settings.
  Future<bool> openSettings();
}

final pushMessagingProvider = Provider<PushMessaging?>((ref) => null);

/// Whether notifications are on, re-read whenever the reader may have
/// changed it (the watcher invalidates it on resume). Null: not available.
final pushPermissionProvider = FutureProvider.autoDispose<PushPermission?>((
  ref,
) {
  return ref.watch(pushMessagingProvider)?.permission();
});

/// FCM delivers to this, in an isolate of its own, whenever a push arrives
/// with the app in the background or closed. It shares nothing with the app:
/// every plugin it uses is set up again here.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundMessageHandler(RemoteMessage message) async {
  final push = BookPush.fromData(message.data);
  if (push == null) return;
  DartPluginRegistrant.ensureInitialized();
  final plugin = FlutterLocalNotificationsPlugin();
  await initializeBookNotifications(plugin);
  await BookNotificationPresenter(
    surface: LocalBookNotificationSurface(plugin),
    ledger: FileBookPushLedger(),
  ).present(push);
}

class FirebasePushMessaging implements PushMessaging {
  FirebasePushMessaging._(this._messaging, this._plugin);

  final FirebaseMessaging _messaging;
  final FlutterLocalNotificationsPlugin _plugin;
  final _opened = StreamController<String>.broadcast();
  String? _unclaimedOpen;
  bool _launchTaken = false;

  static const _settingsChannel = MethodChannel('tomeza/notification_settings');

  /// Starts Firebase and the foreground half of the notifications, or returns
  /// null when this build has no Firebase project — which is not an error:
  /// the app works the same, it just cannot be told when a book is ready.
  static Future<FirebasePushMessaging?> initialize() async {
    if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return null;
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
    } catch (error) {
      debugPrint('Push notifications are off: $error');
      return null;
    }
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundMessageHandler);
    final plugin = FlutterLocalNotificationsPlugin();
    final messaging = FirebasePushMessaging._(FirebaseMessaging.instance, plugin);
    final presenter = BookNotificationPresenter(
      surface: LocalBookNotificationSurface(plugin),
      ledger: FileBookPushLedger(),
    );
    try {
      await initializeBookNotifications(plugin, onOpen: messaging._open);
    } catch (error) {
      debugPrint('Book notifications could not start: $error');
      return null;
    }
    // In the foreground FCM hands the message to the app instead of the
    // background isolate, and it is drawn the same way.
    FirebaseMessaging.onMessage.listen((message) {
      final push = BookPush.fromData(message.data);
      if (push != null) unawaited(presenter.present(push));
    });
    // iOS draws its alerts itself; a tap on one arrives here.
    FirebaseMessaging.onMessageOpenedApp.listen((message) {
      final push = BookPush.fromData(message.data);
      if (push != null) messaging._open(push.projectId);
    });
    return messaging;
  }

  void _open(String projectId) {
    if (_opened.hasListener) {
      _opened.add(projectId);
    } else {
      _unclaimedOpen = projectId;
    }
  }

  @override
  String get platform => Platform.isIOS ? 'ios' : 'android';

  @override
  Stream<String> get tokenRefreshes => _messaging.onTokenRefresh;

  @override
  Stream<String> get openedBooks => _opened.stream;

  @override
  Future<String?> takeLaunchBook() async {
    final unclaimed = _unclaimedOpen;
    _unclaimedOpen = null;
    if (unclaimed != null) return unclaimed;
    if (_launchTaken) return null;
    _launchTaken = true;
    try {
      final launch = await _plugin.getNotificationAppLaunchDetails();
      final payload = launch?.notificationResponse?.payload;
      if (launch?.didNotificationLaunchApp == true &&
          payload != null &&
          payload.isNotEmpty) {
        return payload;
      }
      final initial = await _messaging.getInitialMessage();
      return initial == null ? null : BookPush.fromData(initial.data)?.projectId;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<PushPermission> permission() async {
    try {
      final settings = await _messaging.getNotificationSettings();
      if (_allows(settings.authorizationStatus)) return PushPermission.granted;
      return await _asked.exists()
          ? PushPermission.denied
          : PushPermission.notAsked;
    } catch (_) {
      return PushPermission.denied;
    }
  }

  @override
  Future<bool> wasOffered() => _offered.exists();

  @override
  Future<void> markOffered() => _offered.write();

  @override
  Future<PushPermission> requestPermission() async {
    await _asked.write();
    try {
      final settings = await _messaging.requestPermission();
      return _allows(settings.authorizationStatus)
          ? PushPermission.granted
          : PushPermission.denied;
    } catch (_) {
      return PushPermission.denied;
    }
  }

  static bool _allows(AuthorizationStatus status) =>
      status == AuthorizationStatus.authorized ||
      status == AuthorizationStatus.provisional;

  @override
  Future<String?> token() async {
    try {
      return await _messaging.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Future<bool> openSettings() async {
    try {
      return await _settingsChannel.invokeMethod<bool>('open') ?? false;
    } catch (_) {
      return false;
    }
  }
}

const _asked = _Note('push_permission_asked');
const _offered = _Note('push_offer_shown');

/// A one-time fact — "asked once", "offered once" — as an empty-ish file
/// beside the push ledger. A note that cannot be read reads as never
/// written, which at worst asks one more time.
class _Note {
  const _Note(this._fileName);

  final String _fileName;

  Future<bool> exists() async {
    try {
      return await (await _file()).exists();
    } catch (_) {
      return false;
    }
  }

  Future<void> write() async {
    try {
      await (await _file()).writeAsString(DateTime.now().toIso8601String());
    } catch (_) {
      // See the class comment.
    }
  }

  Future<File> _file() async =>
      File('${(await getApplicationSupportDirectory()).path}/$_fileName');
}
