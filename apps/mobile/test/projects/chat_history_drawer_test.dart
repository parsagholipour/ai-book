import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_drawer_chrome.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';

import 'chat_history_drawer_harness.dart';

void main() {
  testWidgets('search is one tap away in the header and opens focused', (
    tester,
  ) async {
    await tester.pumpWidget(drawerApp(sessions: const [], activeDraftId: ''));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsNothing);
    expect(find.byTooltip('Search chats'), findsOneWidget);
    expect(find.byTooltip('Close'), findsOneWidget);
    // No overflow menu holding a single item.
    expect(find.byTooltip('More'), findsNothing);

    await tester.tap(find.byTooltip('Search chats'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
      isTrue,
    );
  });

  testWidgets('new book button uses a pen-on-paper icon', (tester) async {
    await tester.pumpWidget(drawerApp(sessions: const [], activeDraftId: ''));
    await tester.pumpAndSettle();

    final button = find.widgetWithText(ChatDrawerNewBookButton, 'New book');
    expect(button, findsOneWidget);
    expect(
      find.descendant(of: button, matching: find.byIcon(Icons.edit_document)),
      findsOneWidget,
    );
  });

  testWidgets(
    'search reaches chats beyond the first batch and clears cleanly',
    (tester) async {
      final now = DateTime.now();
      final sessions = List.generate(
        145,
        (index) => chatSession(
          draftId: 'draft-$index',
          title: index == 144 ? 'The moon garden' : 'Book idea $index',
          preview: index == 143
              ? 'A story about a lighthouse'
              : 'Latest message',
          lastMessageAt: now.subtract(Duration(hours: index)),
        ),
      );
      await tester.pumpWidget(
        drawerApp(sessions: sessions, activeDraftId: 'draft-0'),
      );
      await tester.pumpAndSettle();
      expect(find.text('The moon garden'), findsNothing);
      expect(find.byType(TextField), findsNothing);

      await openChatSearch(tester);
      await tester.enterText(find.byType(TextField), '  MOON  ');
      await tester.pumpAndSettle();
      expect(find.text('The moon garden'), findsOneWidget);
      expect(find.text('1 result'), findsOneWidget);
      expect(find.text('Book idea 0'), findsNothing);

      await tester.enterText(find.byType(TextField), 'lighthouse');
      await tester.pumpAndSettle();
      expect(find.text('Book idea 143'), findsOneWidget);
      expect(find.text('A story about a lighthouse'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'unmatched phrase');
      await tester.pumpAndSettle();
      expect(find.text('No matching chats'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(find.text('Book idea 0'), findsOneWidget);
      expect(find.text('No matching chats'), findsNothing);
      await tester.tap(find.byTooltip('Done searching'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(find.text('New book'), findsOneWidget);
      expect(find.text('Your books'), findsOneWidget);
    },
  );

  testWidgets('an empty first search page with a cursor is not a no-match', (
    tester,
  ) async {
    await tester.pumpWidget(
      drawerApp(
        sessions: const [],
        activeDraftId: '',
        repository: SparseSearchRepository(),
      ),
    );
    await tester.pumpAndSettle();
    await openChatSearch(tester);
    await tester.enterText(find.byType(TextField), 'moon');
    await tester.pumpAndSettle();
    expect(find.text('No matching chats'), findsNothing);
    expect(find.text('Could not load more chats.'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets(
    'a one-match search page with a cursor loads the next match without scrolling',
    (tester) async {
      final tail = Completer<MobileChatSessionPage>();
      await tester.pumpWidget(
        drawerApp(
          sessions: const [],
          activeDraftId: '',
          repository: SparseSearchRepository(
            firstPage: [
              chatSession(draftId: 'draft-moon', title: 'Moon garden'),
            ],
            tail: tail,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openChatSearch(tester);
      await tester.enterText(find.byType(TextField), 'moon');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Moon garden'), findsOneWidget);
      expect(find.text('1 result'), findsNothing);
      expect(find.text('Moonlit lake'), findsNothing);

      tail.complete(
        MobileChatSessionPage(
          sessions: [chatSession(draftId: 'draft-lake', title: 'Moonlit lake')],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Moon garden'), findsOneWidget);
      expect(find.text('Moonlit lake'), findsOneWidget);
      expect(find.text('1 result'), findsNothing);
      expect(find.text('2 results'), findsOneWidget);
    },
  );

  testWidgets(
    'scrolling continuously loads the full history beyond 100 chats',
    (tester) async {
      final now = DateTime.now();
      final sessions = List.generate(
        125,
        (index) => chatSession(
          draftId: 'draft-$index',
          title: 'Book idea $index',
          lastMessageAt: now.subtract(Duration(minutes: index)),
        ),
      );
      await tester.pumpWidget(
        drawerApp(sessions: sessions, activeDraftId: 'draft-0'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Show more chats'), findsNothing);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(ChatHistoryDrawer)),
      );
      expect(
        container.read(chatSessionsProvider).requireValue.sessions,
        hasLength(30),
      );
      final scroll = tester
          .widget<CustomScrollView>(find.byType(CustomScrollView))
          .controller!;
      for (var page = 0; page < 4; page++) {
        scroll.jumpTo(scroll.position.maxScrollExtent);
        await tester.pumpAndSettle();
      }
      expect(
        container.read(chatSessionsProvider).requireValue.sessions,
        hasLength(125),
      );
      expect(
        container.read(chatSessionsProvider).requireValue.nextCursor,
        isNull,
      );
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(find.text('Book idea 124'), findsOneWidget);
      expect(find.text('New book'), findsOneWidget);
    },
  );

  testWidgets(
    'a failed older page stays retryable without losing loaded chats',
    (tester) async {
      final sessions = List.generate(
        35,
        (index) =>
            chatSession(draftId: 'draft-$index', title: 'Book idea $index'),
      );
      final repository = RetryingPageRepository(sessions);
      await tester.pumpWidget(
        drawerApp(
          sessions: sessions,
          activeDraftId: 'draft-0',
          repository: repository,
        ),
      );
      await tester.pumpAndSettle();
      final scroll = tester
          .widget<CustomScrollView>(find.byType(CustomScrollView))
          .controller!;
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(find.text('Could not load more chats.'), findsOneWidget);
      expect(find.text('Book idea 29'), findsOneWidget);
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(repository.tailCalls, 1);
      repository.fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(find.text('Book idea 34'), findsOneWidget);
      expect(find.text('Could not load more chats.'), findsNothing);
      expect(repository.tailCalls, 2);
    },
  );

  testWidgets(
    'small screens support large text and searching with a keyboard',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 568));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(
        drawerApp(
          sessions: [
            chatSession(
              draftId: 'draft-0',
              title: 'A long book title that wraps',
            ),
          ],
          activeDraftId: 'draft-0',
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await openChatSearch(tester);
      await tester.enterText(find.byType(TextField), 'long');
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      expect(
        find.text('A long book title that wraps').hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('drawer load errors offer retry', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          creationRepositoryProvider.overrideWithValue(
            ThrowingCreationRepository(),
          ),
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: const Scaffold(body: ChatHistoryDrawer()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Chats unavailable'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pump();
  });

  testWidgets('active chat background stays inside the clipped list', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 520));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final sessions = List.generate(
      24,
      (index) => chatSession(draftId: 'draft-$index', title: 'Chat $index'),
    );

    await tester.pumpWidget(
      drawerApp(sessions: sessions, activeDraftId: 'draft-0'),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('chat-history-scroll-clip')),
      findsOneWidget,
    );

    final selectedTile = tester.widget<ListTile>(
      find.widgetWithText(ListTile, 'Chat 0'),
    );
    expect(selectedTile.selected, isTrue);
    expect(selectedTile.selectedTileColor, Colors.transparent);

    final selectedColor = buildTomezaLightTheme().colorScheme.primaryContainer
        .withValues(alpha: 0.55);
    expect(
      find.ancestor(
        of: find.text('Chat 0'),
        matching: find.byWidgetPredicate(
          (widget) => widget is Material && widget.color == selectedColor,
        ),
      ),
      findsOneWidget,
    );

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -240));
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('date header stays pinned while its chats scroll under it', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final now = DateTime.now();
    final sessions = List.generate(
      24,
      (index) => chatSession(
        draftId: 'draft-$index',
        title: 'Chat $index',
        lastMessageAt: now,
      ),
    );

    await tester.pumpWidget(
      drawerApp(sessions: sessions, activeDraftId: 'other'),
    );
    await tester.pumpAndSettle();

    final listTop = tester.getTopLeft(find.byType(CustomScrollView)).dy;
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Chat 0'), findsOneWidget);

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -300));
    await tester.pumpAndSettle();

    // The first chats scrolled away but the group label held the top edge.
    expect(find.text('Chat 0'), findsNothing);
    expect(find.text('Today'), findsOneWidget);
    final headerTop = tester.getTopLeft(find.text('Today')).dy;
    expect(headerTop, greaterThanOrEqualTo(listTop));
    expect(headerTop, lessThan(listTop + 24));
  });

  testWidgets('sessions group by last message time, not row update time', (
    tester,
  ) async {
    final now = DateTime.now();
    final old = now.subtract(const Duration(days: 45));
    final session = MobileChatSession(
      draftId: 'draft-0',
      title: 'Old Portuguese book',
      preview: 'Latest message',
      messageCount: 2,
      status: 'ACTIVE',
      createdAt: old,
      // The row was touched today (e.g. by a build), but the conversation
      // itself is a month and a half old.
      updatedAt: now,
      lastMessageAt: old,
    );

    await tester.pumpWidget(
      drawerApp(sessions: [session], activeDraftId: 'other'),
    );
    await tester.pumpAndSettle();

    // Past a month a chat is filed under its calendar month, not one "Older".
    expect(
      find.text(
        DefaultMaterialLocalizations().formatMonthYear(
          DateTime(old.year, old.month),
        ),
      ),
      findsOneWidget,
    );
    expect(find.text('Older'), findsNothing);
    expect(find.text('Today'), findsNothing);
  });

  testWidgets('New book is a footer under the list, never over a row', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final now = DateTime.now();
    await tester.pumpWidget(
      drawerApp(
        sessions: [
          for (var i = 0; i < 30; i++)
            chatSession(
              draftId: 'draft-$i',
              title: 'Chat $i',
              lastMessageAt: now.subtract(Duration(days: i)),
            ),
        ],
        activeDraftId: 'other',
      ),
    );
    await tester.pumpAndSettle();

    final listBottom = tester.getBottomLeft(find.byType(CustomScrollView)).dy;
    final buttonTop = tester
        .getTopLeft(find.byType(ChatDrawerNewBookButton))
        .dy;
    expect(buttonTop, greaterThanOrEqualTo(listBottom));
    // The credits stay as tidy as the rest: a balance you can tap.
    expect(find.text('1200 credits'), findsOneWidget);
  });

  testWidgets('long titles wrap to two lines instead of one truncated line', (
    tester,
  ) async {
    const title =
        '10 page book about Neymar and the road to the World Cup in Brazil';
    await tester.pumpWidget(
      drawerApp(
        sessions: [chatSession(draftId: 'draft-0', title: title)],
        activeDraftId: 'other',
      ),
    );
    await tester.pumpAndSettle();

    final text = tester.widget<Text>(find.text(title));
    expect(text.maxLines, 2);
  });

  test('fromJson falls back to updatedAt when lastMessageAt is missing', () {
    final json = <String, dynamic>{
      'draftId': 'draft-0',
      'title': 'Legacy chat',
      'preview': '',
      'messageCount': 1,
      'status': 'ACTIVE',
      'createdAt': '2026-06-01T00:00:00.000Z',
      'updatedAt': '2026-06-15T00:00:00.000Z',
    };

    final legacy = MobileChatSession.fromJson(json);
    expect(legacy.lastMessageAt, DateTime.parse('2026-06-15T00:00:00.000Z'));

    final current = MobileChatSession.fromJson({
      ...json,
      'lastMessageAt': '2026-06-10T00:00:00.000Z',
    });
    expect(current.lastMessageAt, DateTime.parse('2026-06-10T00:00:00.000Z'));
  });
}
