import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/book_series.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/creation_preset_merge.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The series link in the creation chat: the offer the server makes once a
// mentioned character already appears in one of the reader's finished books,
// the answer and its reminder row, and a chat started as "Write the next book".

Widget _seriesApp({
  required ScriptedCreationRepository creation,
  BookSeriesStart? seriesStart,
}) {
  return ProviderScope(
    overrides: [
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      creationRepositoryProvider.overrideWithValue(creation),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      creationPrefsStoreProvider.overrideWithValue(MemoryCreationPrefsStore()),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: CreationChatScreen(startFresh: true, seriesStart: seriesStart),
    ),
  );
}

/// Frames in 100 ms steps: a focused composer's cursor never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _send(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField).first, text);
  await tester.pump();
  await tester.tap(find.byTooltip('Send'));
  await _settle(tester);
}

const _offer = {
  'books': [
    {
      'projectId': 'book-1',
      'title': 'The Night Garden',
      'characterNames': ['Luna'],
      'updatedAt': '2026-10-01T10:00:00.000Z',
    },
  ],
  'choice': null,
};

void main() {
  testWidgets('a mentioned character already in a finished book is offered '
      'that book, and the answer stays changeable', (tester) async {
    final creation = ScriptedCreationRepository()..sessionSeriesJson = _offer;
    await tester.pumpWidget(_seriesApp(creation: creation));
    await _settle(tester);
    expect(find.byKey(const ValueKey('series-offer')), findsNothing);

    await _send(tester, 'Another adventure for Luna');

    expect(find.text('Luna is already in “The Night Garden”'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('series-continue')));
    await _settle(tester);

    expect(creation.seriesChoices.single.mode, BookSeriesMode.continuation);
    expect(creation.seriesChoices.single.projectId, 'book-1');
    expect(find.byKey(const ValueKey('series-offer')), findsNothing);
    expect(find.text('Continues “The Night Garden”'), findsOneWidget);

    // A mis-tap is one tap away from being undone.
    await tester.tap(find.byKey(const ValueKey('series-change')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('series-offer')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('series-standalone')));
    await _settle(tester);

    expect(creation.seriesChoices.last.mode, BookSeriesMode.standalone);
    expect(creation.seriesChoices.last.projectId, isNull);
    expect(find.text('A separate story'), findsOneWidget);
  });

  testWidgets('a linked answer brings the earlier book’s format to the next '
      'message', (tester) async {
    final creation = ScriptedCreationRepository()..sessionSeriesJson = _offer;
    await tester.pumpWidget(_seriesApp(creation: creation));
    await _settle(tester);
    await _send(tester, 'Another adventure for Luna');
    await tester.tap(find.byKey(const ValueKey('series-continue')));
    await _settle(tester);

    await _send(tester, 'She learns to swim');

    final presets = creation.sentPresets.last!;
    expect(presets.bookTypeChoice, 'children_story');
    expect(presets.qualityPreset, 'premium');
    expect(presets.coverEnabled, isFalse);
    expect(presets.targetPages, 12);
  });

  testWidgets('Change still offers the linked book when the offer lists none', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()
      ..sessionSeriesJson = const {
        'books': <dynamic>[],
        'choice': {
          'mode': 'continuation',
          'projectId': 'book-1',
          'title': 'The Night Garden',
        },
      };
    await tester.pumpWidget(_seriesApp(creation: creation));
    await _settle(tester);
    await _send(tester, 'Another adventure');
    expect(find.text('Continues “The Night Garden”'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('series-change')));
    await _settle(tester);

    expect(find.text('This book and “The Night Garden”'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('series-inspired')));
    await _settle(tester);
    expect(creation.seriesChoices.single.mode, BookSeriesMode.inspired);
    expect(creation.seriesChoices.single.projectId, 'book-1');
  });

  testWidgets('the offer waits while a message is on its way, and the '
      'composer waits for an answer', (tester) async {
    final creation = ScriptedCreationRepository()..sessionSeriesJson = _offer;
    await tester.pumpWidget(_seriesApp(creation: creation));
    await _settle(tester);
    await _send(tester, 'Another adventure for Luna');

    final send = Completer<void>();
    creation.sendGate = send.future;
    await _send(tester, 'She learns to swim');
    await tester.tap(find.byKey(const ValueKey('series-continue')));
    await _settle(tester);
    // Answering moves the session's revision, so it is not sent beside the message.
    expect(creation.seriesChoices, isEmpty);
    send.complete();
    creation.sendGate = null;
    await _settle(tester);

    final answer = Completer<void>();
    creation.seriesAnswerGate = answer;
    await tester.tap(find.byKey(const ValueKey('series-continue')));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, 'And a boat');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    expect(creation.sentMessages, isNot(contains('And a boat')));
    answer.complete();
    await _settle(tester);
    expect(creation.seriesChoices.single.mode, BookSeriesMode.continuation);
  });

  testWidgets('"Write the next book" opens a chat already linked, in the '
      'book’s format, and sends nothing until the first message', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final start = await creation.loadNextBook('book-1');
    await tester.pumpWidget(_seriesApp(creation: creation, seriesStart: start));
    await _settle(tester);

    const prefill = 'In the next book after “The Night Garden”, ';
    expect(find.text(prefill), findsOneWidget);
    expect(find.text('Continues “The Night Garden”'), findsOneWidget);
    expect(creation.startedMessages, isEmpty);

    await _send(tester, '${prefill}Luna learns to swim');

    final series = creation.startedSeries.single!;
    expect(series.mode, BookSeriesMode.continuation);
    expect(series.projectId, 'book-1');
    expect(creation.startedPresets.single!.bookTypeChoice, 'children_story');
  });

  testWidgets('a "Write the next book" chat can become a new story in the '
      'world before it is sent', (tester) async {
    final creation = ScriptedCreationRepository();
    final start = await creation.loadNextBook('book-1');
    await tester.pumpWidget(_seriesApp(creation: creation, seriesStart: start));
    await _settle(tester);

    await tester.tap(find.byKey(const ValueKey('series-change')));
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('series-inspired')));
    await _settle(tester);

    // Nothing reached the server: there is no session to answer yet.
    expect(creation.seriesChoices, isEmpty);
    expect(
      find.text('A new story in the world of “The Night Garden”'),
      findsOneWidget,
    );
    await _send(tester, 'Luna visits the sea');
    expect(creation.startedSeries.single!.mode, BookSeriesMode.inspired);
  });

  group('adopting the earlier book’s format', () {
    const current = MobileCreationPresets(
      bookType: 'guide',
      bookTypeChoice: 'practical_guide',
      lengthPreset: 'long',
      qualityPreset: 'fast',
      coverEnabled: true,
      illustrationsEnabled: false,
      pageCountMode: 'custom',
      targetPages: 40,
      pageCountSource: 'settings',
    );
    const format = MobileCreationPresets(
      bookType: 'short_story',
      bookTypeChoice: 'children_story',
      lengthPreset: 'short',
      qualityPreset: 'premium',
      coverEnabled: false,
      illustrationsEnabled: true,
      pageCountMode: 'custom',
      targetPages: 12,
      pageCountSource: 'chat',
    );

    test('keeps every setting the reader chose and takes the rest', () {
      final adopted = adoptSeriesFormat(
        current: current,
        format: format,
        bookTypeChosen: false,
        lengthChosen: true,
        finishChosen: true,
        coverChosen: false,
        illustrationsChosen: false,
      );
      expect(adopted.bookTypeChoice, 'children_story');
      expect(adopted.bookType, 'short_story');
      expect(adopted.lengthPreset, 'long');
      expect(adopted.targetPages, 40);
      expect(adopted.pageCountSource, 'settings');
      expect(adopted.qualityPreset, 'fast');
      expect(adopted.coverEnabled, isFalse);
      expect(adopted.illustrationsEnabled, isTrue);
    });

    test('a reader who chose nothing gets the whole format', () {
      final adopted = adoptSeriesFormat(
        current: current,
        format: format,
        bookTypeChosen: false,
        lengthChosen: false,
        finishChosen: false,
        coverChosen: false,
        illustrationsChosen: false,
      );
      expect(adopted.toJson(), format.toJson());
    });

    test('an answer carries the format pinned to a concrete book type', () {
      final answer = MobileCreationSeriesAnswer.fromJson({
        'turn': turnJson(assistantMessage: 'Okay.', canBuild: false),
        'seriesPresets': {...format.toJson(), 'bookTypeChoice': 'auto'},
      });
      expect(answer.chatFormat?.bookTypeChoice, 'adult_story');
    });
  });

  group('the series wire', () {
    test('reads an answer this build does not know as no answer', () {
      final series = MobileCreationSeries.fromJson({
        ..._offer,
        'choice': {'mode': 'prequel', 'projectId': 'book-1', 'title': 'X'},
      })!;
      expect(series.choice, isNull);
      expect(series.isOpen, isTrue);
    });

    test('refuses a linked answer that names no book', () {
      expect(
        MobileCreationSeriesChoice.fromJson({'mode': 'continuation'}),
        isNull,
      );
      expect(
        MobileCreationSeriesChoice.fromJson({'mode': 'standalone'})?.mode,
        BookSeriesMode.standalone,
      );
    });

    test('a session from a server that sends no series has none', () {
      final session = MobileCreationSession.fromJson({
        'draftId': 'draft-1',
        'status': 'ACTIVE',
        'messages': const [],
        'updatedAt': '2026-06-15T00:00:00.000Z',
      });
      expect(session.series, isNull);
    });

    test('a pre-session story of its own is held, never sent as a link', () {
      const pending = PendingBookSeries(
        projectId: 'book-1',
        title: 'The Night Garden',
        mode: BookSeriesMode.standalone,
      );
      expect(pending.mode.linksBook, isFalse);
    });
  });
}
