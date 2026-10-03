import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/notifications/data/book_notification_presenter.dart';
import 'package:tomeza/features/notifications/domain/book_push.dart';

class _RecordingSurface implements BookNotificationSurface {
  final calls = <String>[];

  @override
  Future<void> showProgress({
    required int id,
    required String projectId,
    required String title,
    required String body,
    required int percent,
  }) async {
    calls.add('progress $projectId $percent% "$title" "$body"');
  }

  @override
  Future<void> showSettled({
    required int id,
    required String projectId,
    required String title,
    required String body,
  }) async {
    calls.add('settled $projectId "$title" "$body"');
  }

  @override
  Future<void> cancel(int id) async {
    calls.add('cancel $id');
  }
}

BookPush _push(
  BookPushKind kind,
  int sentAt, {
  String projectId = 'book-1',
  int? percent,
}) {
  return BookPush(
    kind: kind,
    projectId: projectId,
    sentAt: sentAt,
    title: kind == BookPushKind.progress ? 'The Lost Fox' : 'Your book is ready',
    body: kind == BookPushKind.progress
        ? 'Writing chapter 2'
        : '“The Lost Fox” is ready to read.',
    percent: percent,
  );
}

void main() {
  group('BookPush.fromData', () {
    test('reads the server message, all of whose values are strings', () {
      final push = BookPush.fromData({
        'kind': 'book_progress',
        'projectId': 'book-1',
        'sentAt': '1759482000000',
        'title': 'The Lost Fox',
        'body': 'Writing chapter 2',
        'percent': '42',
      })!;
      expect(push.kind, BookPushKind.progress);
      expect(push.projectId, 'book-1');
      expect(push.sentAt, 1759482000000);
      expect(push.percent, 42);
      expect(push.title, 'The Lost Fox');
    });

    test('ignores a kind this build does not know, or a message it cannot '
        'place', () {
      final base = {
        'kind': 'book_ready',
        'projectId': 'book-1',
        'sentAt': '1',
      };
      expect(BookPush.fromData(base), isNotNull);
      expect(BookPush.fromData({...base, 'kind': 'book_audiobook'}), isNull);
      expect(BookPush.fromData({...base, 'projectId': ''}), isNull);
      expect(BookPush.fromData({...base, 'sentAt': 'soon'}), isNull);
      expect(BookPush.fromData({'kind': 'book_ready'}), isNull);
    });

    test('keeps a percent in range', () {
      final push = BookPush.fromData({
        'kind': 'book_progress',
        'projectId': 'book-1',
        'sentAt': '1',
        'percent': '140',
      })!;
      expect(push.percent, 100);
    });
  });

  test('one book has one stable, positive notification slot', () {
    expect(bookNotificationId('cmg8x2abc0001'), bookNotificationId('cmg8x2abc0001'));
    expect(bookNotificationId('cmg8x2abc0001'), isNot(bookNotificationId('cmg8x2abc0002')));
    // Pinned: the background isolate and the app must compute the same slot.
    expect(bookNotificationId('book-1'), 283438747);
    for (final id in ['', 'a', 'cmg8x2abc0001', 'x' * 64]) {
      expect(bookNotificationId(id), inInclusiveRange(1, 0x7fffffff));
    }
  });

  group('BookNotificationPresenter', () {
    late _RecordingSurface surface;
    late BookNotificationPresenter presenter;
    final slot = bookNotificationId('book-1');

    setUp(() {
      surface = _RecordingSurface();
      presenter = BookNotificationPresenter(
        surface: surface,
        ledger: MemoryBookPushLedger(),
      );
    });

    test('draws progress as a bar, then replaces it with one alert', () async {
      await presenter.present(_push(BookPushKind.progress, 1, percent: 20));
      await presenter.present(_push(BookPushKind.progress, 2, percent: 34));
      await presenter.present(_push(BookPushKind.ready, 3));

      expect(surface.calls, [
        'progress book-1 20% "The Lost Fox" "Writing chapter 2"',
        'progress book-1 34% "The Lost Fox" "Writing chapter 2"',
        'cancel $slot',
        'settled book-1 "Your book is ready" "“The Lost Fox” is ready to read."',
      ]);
    });

    test('drops a message no newer than the last one shown for the book, so '
        'a late progress update cannot cover "ready"', () async {
      await presenter.present(_push(BookPushKind.ready, 10));
      expect(
        await presenter.present(_push(BookPushKind.progress, 9, percent: 80)),
        isFalse,
      );
      expect(
        await presenter.present(_push(BookPushKind.ready, 10)),
        isFalse,
      );
      expect(surface.calls.where((call) => call.startsWith('progress')), isEmpty);
    });

    test('keeps each book in order on its own', () async {
      await presenter.present(_push(BookPushKind.progress, 10, percent: 50));
      expect(
        await presenter.present(
          _push(BookPushKind.progress, 5, projectId: 'book-2', percent: 10),
        ),
        isTrue,
      );
    });

    test('a stop only clears the bar', () async {
      await presenter.present(_push(BookPushKind.progress, 1, percent: 40));
      await presenter.present(_push(BookPushKind.clear, 2));
      expect(surface.calls.last, 'cancel $slot');
      expect(surface.calls.where((call) => call.startsWith('settled')), isEmpty);
    });
  });

  group('FileBookPushLedger', () {
    late Directory root;

    setUp(() async {
      root = await Directory.systemTemp.createTemp('book_push_ledger');
    });
    tearDown(() async {
      await root.delete(recursive: true);
    });

    test('is shared by every isolate that opens it', () async {
      await FileBookPushLedger(directory: () async => root).record('book-1', 42);
      expect(
        await FileBookPushLedger(directory: () async => root).lastSentAt('book-1'),
        42,
      );
    });

    test('forgets books it has not heard about for a week', () async {
      final ledger = FileBookPushLedger(directory: () async => root);
      const day = 24 * 60 * 60 * 1000;
      await ledger.record('old', 0);
      await ledger.record('new', 8 * day);
      expect(await ledger.lastSentAt('old'), isNull);
      expect(await ledger.lastSentAt('new'), 8 * day);
    });

    test('costs only the ordering guard when the file is unreadable', () async {
      await File('${root.path}/book_push_ledger.json').writeAsString('{not json');
      final ledger = FileBookPushLedger(directory: () async => root);
      expect(await ledger.lastSentAt('book-1'), isNull);
      await ledger.record('book-1', 7);
      expect(await ledger.lastSentAt('book-1'), 7);
    });
  });
}
