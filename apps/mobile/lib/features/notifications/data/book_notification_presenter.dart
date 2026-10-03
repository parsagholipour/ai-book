import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/book_push.dart';

/// Draws book pushes as local notifications: a quiet progress bar while the
/// book is written, replaced by one alert when it is ready or needs attention.
///
/// The server sends Android data-only messages, so everything about how a
/// push looks is decided here — in the foreground and, for a backgrounded or
/// closed app, in the isolate `firebaseBackgroundMessageHandler` starts.
class BookNotificationPresenter {
  BookNotificationPresenter({
    required this._surface,
    required this._ledger,
  });

  final BookNotificationSurface _surface;
  final BookPushLedger _ledger;

  /// Shows [push], or drops it when it is no newer than the last message shown
  /// for its book — a progress update FCM delivered late must not put the bar
  /// back over "your book is ready". Returns whether anything changed.
  Future<bool> present(BookPush push) async {
    final last = await _ledger.lastSentAt(push.projectId);
    if (last != null && push.sentAt <= last) return false;
    await _ledger.record(push.projectId, push.sentAt);
    final id = bookNotificationId(push.projectId);
    switch (push.kind) {
      case BookPushKind.progress:
        await _surface.showProgress(
          id: id,
          projectId: push.projectId,
          title: push.title,
          body: push.body,
          percent: push.percent ?? 0,
        );
      case BookPushKind.ready:
      case BookPushKind.failed:
        // Cancelled first, so the ending alerts as a new notification instead
        // of arriving as a silent update to a bar that only alerted once.
        await _surface.cancel(id);
        await _surface.showSettled(
          id: id,
          projectId: push.projectId,
          title: push.title,
          body: push.body,
        );
      case BookPushKind.clear:
        await _surface.cancel(id);
    }
    return true;
  }
}

/// The platform half of [BookNotificationPresenter], apart so its decisions
/// can be tested without a device.
abstract interface class BookNotificationSurface {
  Future<void> showProgress({
    required int id,
    required String projectId,
    required String title,
    required String body,
    required int percent,
  });

  Future<void> showSettled({
    required int id,
    required String projectId,
    required String title,
    required String body,
  });

  Future<void> cancel(int id);
}

/// The newest message shown per book.
abstract interface class BookPushLedger {
  Future<int?> lastSentAt(String projectId);
  Future<void> record(String projectId, int sentAt);
}

class MemoryBookPushLedger implements BookPushLedger {
  final _entries = <String, int>{};

  @override
  Future<int?> lastSentAt(String projectId) async => _entries[projectId];

  @override
  Future<void> record(String projectId, int sentAt) async {
    _entries[projectId] = sentAt;
  }
}

/// A small JSON file, because the background isolate that shows most pushes
/// shares no memory with the app — or with the next background isolate.
/// Entries older than [_keep] are dropped on write. A file that cannot be read
/// or written costs only the ordering guard, never the notification.
class FileBookPushLedger implements BookPushLedger {
  FileBookPushLedger({Future<Directory> Function()? directory})
    : _directory = directory ?? getApplicationSupportDirectory;

  final Future<Directory> Function() _directory;

  static const _fileName = 'book_push_ledger.json';
  static const _keep = Duration(days: 7);

  @override
  Future<int?> lastSentAt(String projectId) async {
    final entries = await _read();
    return entries[projectId];
  }

  @override
  Future<void> record(String projectId, int sentAt) async {
    try {
      final entries = await _read();
      entries[projectId] = sentAt;
      entries.removeWhere(
        (_, at) => sentAt - at > _keep.inMilliseconds,
      );
      final file = File('${(await _directory()).path}/$_fileName');
      await file.writeAsString(jsonEncode(entries), flush: true);
    } catch (_) {
      // See the class comment.
    }
  }

  Future<Map<String, int>> _read() async {
    try {
      final file = File('${(await _directory()).path}/$_fileName');
      if (!await file.exists()) return {};
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map<String, dynamic>) return {};
      return {
        for (final entry in decoded.entries)
          if (entry.value is int) entry.key: entry.value as int,
      };
    } catch (_) {
      return {};
    }
  }
}

/// Android channels: one the reader can silence without losing the other.
/// The ids are permanent — Android keeps a channel's settings by id, and a
/// renamed one would come back with its defaults.
const bookProgressChannelId = 'com.tomeza.tomeza.book_progress';
const bookReadyChannelId = 'com.tomeza.tomeza.book_ready';

/// The status-bar icon: the brand bubble as a white silhouette
/// (`android/app/src/main/res/drawable-*/ic_stat_tomeza.png`).
const bookNotificationIcon = 'ic_stat_tomeza';

const _brandColor = Color(0xFF0F6B5C);

/// A progress bar nobody refreshes goes away by itself. The server refreshes a
/// live one at least every five minutes, so only a book whose ending push was
/// lost — or a server that stopped sending — ever reaches this.
const _progressTimeout = Duration(minutes: 20);

class LocalBookNotificationSurface implements BookNotificationSurface {
  LocalBookNotificationSurface(this._plugin);

  final FlutterLocalNotificationsPlugin _plugin;

  @override
  Future<void> showProgress({
    required int id,
    required String projectId,
    required String title,
    required String body,
    required int percent,
  }) {
    return _plugin.show(
      id: id,
      title: title,
      body: body,
      payload: projectId,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          bookProgressChannelId,
          'Book progress',
          channelDescription: 'A progress bar while a book is being written',
          icon: bookNotificationIcon,
          color: _brandColor,
          importance: Importance.low,
          priority: Priority.low,
          playSound: false,
          enableVibration: false,
          channelShowBadge: false,
          onlyAlertOnce: true,
          silent: true,
          autoCancel: false,
          showWhen: false,
          showProgress: true,
          maxProgress: 100,
          progress: percent,
          subText: '$percent%',
          category: AndroidNotificationCategory.progress,
          timeoutAfter: _progressTimeout.inMilliseconds,
        ),
      ),
    );
  }

  @override
  Future<void> showSettled({
    required int id,
    required String projectId,
    required String title,
    required String body,
  }) {
    return _plugin.show(
      id: id,
      title: title,
      body: body,
      payload: projectId,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          bookReadyChannelId,
          'Finished books',
          channelDescription:
              'When a book is ready to read, or needs your attention',
          icon: bookNotificationIcon,
          color: _brandColor,
          importance: Importance.high,
          priority: Priority.high,
          category: AndroidNotificationCategory.status,
          styleInformation: BigTextStyleInformation(body),
        ),
      ),
    );
  }

  @override
  Future<void> cancel(int id) => _plugin.cancel(id: id);
}

/// Sets the plugin up to draw. [onOpen] receives the book a tapped
/// notification belongs to; the background isolate passes none, because a
/// tap always reopens the app and is answered there.
Future<void> initializeBookNotifications(
  FlutterLocalNotificationsPlugin plugin, {
  void Function(String projectId)? onOpen,
}) async {
  await plugin.initialize(
    settings: const InitializationSettings(
      android: AndroidInitializationSettings(bookNotificationIcon),
      // Firebase asks for the permission; this plugin must not ask again.
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    ),
    onDidReceiveNotificationResponse: onOpen == null
        ? null
        : (response) {
            final projectId = response.payload;
            if (projectId != null && projectId.isNotEmpty) onOpen(projectId);
          },
  );
}
