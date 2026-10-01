import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_prefs_store.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/creation_labels.dart';
import 'package:tomeza/features/sharing/data/book_share_repository.dart';
import 'package:tomeza/features/sharing/data/pending_remix.dart';
import 'package:tomeza/features/sharing/domain/book_remix.dart';
import 'package:tomeza/features/sharing/presentation/remix_location.dart';
import 'package:tomeza/features/sharing/presentation/remix_screen.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../projects/creation_chat_fakes.dart';
import '../../projects/creation_chat_harness.dart';
import 'fake_book_share_repository.dart';

// "Make a book like this": the remix route, from the link to the chat it
// opens. The deep link itself, through the whole app, is
// test/app/remix_deep_link_test.dart.

Widget _remixApp({
  required CreationRepository creation,
  required BookShareRepository shares,
}) {
  final router = GoRouter(
    initialLocation: '/remix/abc123',
    routes: [
      GoRoute(
        path: '/remix/:slug',
        builder: (context, state) =>
            RemixScreen(slug: state.pathParameters['slug']!),
      ),
      // Mirrors app_router.dart's route, extra included.
      GoRoute(
        path: '/books/new',
        builder: (context, state) => CreationChatScreen(
          startFresh: state.uri.queryParameters['fresh'] == 'true',
          resetToken: state.uri.queryParameters['r'],
          remix: state.extra is BookRemix ? state.extra as BookRemix : null,
        ),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      apiAuthHeadersProvider.overrideWith(
        (ref) async => const <String, String>{},
      ),
      creationRepositoryProvider.overrideWithValue(creation),
      billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      creationPrefsStoreProvider.overrideWithValue(MemoryCreationPrefsStore()),
      bookShareRepositoryProvider.overrideWithValue(shares),
      pendingRemixStoreProvider.overrideWithValue(MemoryPendingRemixStore()),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: router,
    ),
  );
}

/// Frames in 100 ms steps: the loading sparkle and a focused composer's
/// cursor never settle.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  const prefill = 'A short story like “The Lighthouse Cat”, about ';

  testWidgets('a remix link opens a new chat in the shared book’s format, '
      'its first line written and nothing sent', (tester) async {
    final creation = ScriptedCreationRepository();
    final shares = FakeBookShareRepository(remix: lighthouseCat());
    await tester.pumpWidget(_remixApp(creation: creation, shares: shares));

    // A real wait while the format arrives, then the chat takes its place.
    expect(find.text('Setting up a book like this one'), findsOneWidget);
    await _settle(tester);

    expect(shares.remixSlugs, ['abc123']);
    expect(find.byType(RemixScreen), findsNothing);
    expect(find.byType(CreationChatScreen), findsOneWidget);
    expect(find.text(prefill), findsOneWidget);
    // Nothing reached the server: no session, no message, no allowance.
    expect(creation.startedRemixSlugs, isEmpty);
    expect(creation.startedMessages, isEmpty);
    expect(creation.sentMessages, isEmpty);

    // The reader finishes the sentence; that send starts the session and
    // carries the share it came from, with the format applied.
    await tester.enterText(
      find.byType(TextField).first,
      '${prefill}a fox who keeps a lighthouse',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await _settle(tester);

    expect(creation.startedMessages, [
      '${prefill}a fox who keeps a lighthouse',
    ]);
    expect(creation.startedRemixSlugs, ['abc123']);
    final presets = creation.startedPresets.single!;
    expect(presets.bookType, 'short_story');
    expect(presets.bookTypeChoice, 'adult_story');
    expect(presets.lengthPreset, 'standard');
    expect(presets.qualityPreset, 'premium');
    expect(presets.coverEnabled, isTrue);
    expect(presets.illustrationsEnabled, isFalse);
    expect(presets.pageCountMode, 'custom');
    expect(presets.targetPages, 24);

    await tester.teardownScreen();
  });

  testWidgets('a book that is no longer shared says so and offers a new '
      'book of the reader’s own', (tester) async {
    final creation = ScriptedCreationRepository();
    final shares = FakeBookShareRepository(
      remixError: const ApiException(
        code: 'REMIX_NOT_AVAILABLE',
        message: 'This book is no longer shared.',
        statusCode: 410,
      ),
    );
    await tester.pumpWidget(_remixApp(creation: creation, shares: shares));
    await _settle(tester);

    expect(find.text('This book is no longer shared'), findsOneWidget);
    expect(find.byType(CreationChatScreen), findsNothing);

    await tester.tap(find.text('Start a new book'));
    await _settle(tester);

    expect(find.byType(CreationChatScreen), findsOneWidget);
    expect(find.text(prefill), findsNothing);
    expect(creation.startedRemixSlugs, isEmpty);

    await tester.teardownScreen();
  });

  testWidgets('a link that could not be reached this time can be tried again', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final shares = FakeBookShareRepository(
      remix: lighthouseCat(),
      remixError: const ApiException(
        code: 'NETWORK_ERROR',
        message: 'Check your connection and try again.',
      ),
    );
    await tester.pumpWidget(_remixApp(creation: creation, shares: shares));
    await _settle(tester);

    expect(find.text('Couldn’t open this book'), findsOneWidget);
    shares.remixError = null;
    await tester.tap(find.text('Try again'));
    await _settle(tester);

    expect(find.text(prefill), findsOneWidget);
    await tester.teardownScreen();
  });

  test('a detected book type still starts the chat on a concrete one', () {
    // `auto` would let the chat re-derive the product type from its own
    // lane detection and send a short story's format as a guide.
    expect(lighthouseCat(bookTypeChoice: 'auto').bookTypeChoice, 'adult_story');
    expect(
      lighthouseCat(bookTypeChoice: 'children_story').bookTypeChoice,
      'children_story',
    );
    expect(
      remixComposerPrefill(bookTypeChoice: 'offer_guide', title: 'Ten Walks'),
      'An offer guide like “Ten Walks”, about ',
    );
    expect(
      remixComposerPrefill(bookTypeChoice: 'workbook', title: '  '),
      'A workbook about ',
    );
  });

  test('tomeza://remix/<slug> becomes the in-app remix location', () {
    expect(
      remixLocationForDeepLink(Uri.parse('tomeza://remix/abc123')),
      '/remix/abc123',
    );
    expect(
      remixLocationForDeepLink(Uri.parse('tomeza://remix/abc123/?utm=x')),
      '/remix/abc123',
    );
    expect(remixLocationForDeepLink(Uri.parse('tomeza://remix')), '/home');
    expect(remixLocationForDeepLink(Uri.parse('/remix/abc123')), isNull);
    expect(
      remixLocationForDeepLink(Uri.parse('https://tomeza.app/remix/abc')),
      isNull,
    );
    expect(remixSlugFromPath('/remix/abc123'), 'abc123');
    expect(remixSlugFromPath('/remix'), isNull);
    expect(remixSlugFromPath('/books/new'), isNull);
  });

  test('a pending remix older than an hour is forgotten', () async {
    final store = MemoryPendingRemixStore(
      PendingRemixRecord(
        'old',
        DateTime.now().subtract(const Duration(hours: 2)),
      ),
    );
    final stale = PendingRemix(store);
    await Future<void>.delayed(Duration.zero);
    expect(stale.slug, isNull);
    expect(store.record, isNull);

    final fresh = PendingRemix(
      MemoryPendingRemixStore(PendingRemixRecord('abc123', DateTime.now())),
    );
    await Future<void>.delayed(Duration.zero);
    expect(fresh.slug, 'abc123');
  });
}
