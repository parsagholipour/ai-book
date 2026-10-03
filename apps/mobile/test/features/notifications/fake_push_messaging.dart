import 'dart:async';

import 'package:tomeza/features/notifications/data/push_device_repository.dart';
import 'package:tomeza/features/notifications/data/push_messaging.dart';

/// [PushMessaging] without Firebase: a permission, a token and taps the test
/// sets by hand.
class FakePushMessaging implements PushMessaging {
  FakePushMessaging({
    this.currentPermission = PushPermission.granted,
    this.currentToken = 'fcm-token-1',
    this.launchBook,
    this.answer = PushPermission.granted,
  });

  PushPermission currentPermission;
  String? currentToken;
  String? launchBook;

  /// What the system prompt answers.
  PushPermission answer;

  bool offered = false;
  int permissionRequests = 0;
  int settingsOpened = 0;
  final _opened = StreamController<String>.broadcast();
  final _refreshes = StreamController<String>.broadcast();

  void tap(String projectId) => _opened.add(projectId);

  void rotateToken(String token) {
    currentToken = token;
    _refreshes.add(token);
  }

  @override
  Future<PushPermission> permission() async => currentPermission;

  @override
  Future<PushPermission> requestPermission() async {
    permissionRequests += 1;
    currentPermission = answer;
    return answer;
  }

  @override
  Future<bool> wasOffered() async => offered;

  @override
  Future<void> markOffered() async => offered = true;

  @override
  Future<String?> token() async => currentToken;

  @override
  String get platform => 'android';

  @override
  Stream<String> get tokenRefreshes => _refreshes.stream;

  @override
  Stream<String> get openedBooks => _opened.stream;

  @override
  Future<String?> takeLaunchBook() async {
    final book = launchBook;
    launchBook = null;
    return book;
  }

  @override
  Future<bool> openSettings() async {
    settingsOpened += 1;
    return true;
  }
}

class FakePushDeviceRepository implements PushDeviceRepository {
  final calls = <String>[];

  @override
  Future<void> register({required String token, required String platform}) async {
    calls.add('register $token $platform');
  }

  @override
  Future<void> unregister(String token) async {
    calls.add('unregister $token');
  }
}
