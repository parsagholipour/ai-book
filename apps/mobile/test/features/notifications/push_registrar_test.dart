import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notifications/data/push_device_repository.dart';
import 'package:tomeza/features/notifications/data/push_messaging.dart';

import 'fake_push_messaging.dart';

void main() {
  late FakePushMessaging messaging;
  late FakePushDeviceRepository repository;
  late PushRegistrar registrar;

  setUp(() {
    messaging = FakePushMessaging();
    repository = FakePushDeviceRepository();
    registrar = PushRegistrar(messaging: messaging, repository: repository);
  });

  test('files the token once per account, however often it is asked', () async {
    await registrar.sync(userId: 'user-a');
    await registrar.sync(userId: 'user-a');
    await registrar.sync(userId: 'user-a');
    expect(repository.calls, ['register fcm-token-1 android']);
  });

  test('files it again for the next account, and for a rotated token', () async {
    await registrar.sync(userId: 'user-a');
    await registrar.sync(userId: null);
    await registrar.sync(userId: 'user-b');
    messaging.currentToken = 'fcm-token-2';
    await registrar.sync(userId: 'user-b');
    expect(repository.calls, [
      'register fcm-token-1 android',
      'register fcm-token-1 android',
      'register fcm-token-2 android',
    ]);
  });

  test('withdraws the token once when notifications are off, and files it '
      'again when they come back on', () async {
    await registrar.sync(userId: 'user-a');
    messaging.currentPermission = PushPermission.denied;
    await registrar.sync(userId: 'user-a');
    await registrar.sync(userId: 'user-a');
    messaging.currentPermission = PushPermission.granted;
    await registrar.sync(userId: 'user-a');
    expect(repository.calls, [
      'register fcm-token-1 android',
      'unregister fcm-token-1',
      'register fcm-token-1 android',
    ]);
  });

  test('says nothing without a token or a signed-in reader', () async {
    messaging.currentToken = null;
    await registrar.sync(userId: 'user-a');
    messaging.currentToken = 'fcm-token-1';
    await registrar.sync(userId: null);
    expect(repository.calls, isEmpty);
  });

  test('a failed call is tried again on the next sync', () async {
    final failing = _FailingOnceRepository();
    final retrying = PushRegistrar(messaging: messaging, repository: failing);
    await retrying.sync(userId: 'user-a');
    await retrying.sync(userId: 'user-a');
    expect(failing.attempts, 2);
    expect(failing.succeeded, 1);
  });
}

class _FailingOnceRepository implements PushDeviceRepository {
  int attempts = 0;
  int succeeded = 0;

  @override
  Future<void> register({required String token, required String platform}) async {
    attempts += 1;
    if (attempts == 1) throw StateError('offline');
    succeeded += 1;
  }

  @override
  Future<void> unregister(String token) async {}
}
