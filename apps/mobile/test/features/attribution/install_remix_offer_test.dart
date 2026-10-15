import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/app/routing/app_router.dart';
import 'package:tomeza/features/attribution/data/install_attribution_tracker.dart';
import 'package:tomeza/features/attribution/data/install_referrer_source.dart';
import 'package:tomeza/features/attribution/domain/install_attribution.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';

import '../../app/app_test_fixtures.dart';
import '../sharing/fake_book_share_repository.dart';
import 'install_attribution_test.dart' show FakeReferrerSource;

// The install remix offer through the whole app: the real router, whose home
// is the creation chat, and the watcher the app shell mounts. The offer used
// to be made by a home screen no route built, and a test that mounted its own
// stand-in home passed while nothing was ever reported or offered.

const _offerTitle = 'Make a book like the one you saw?';

const _fromShare = InstallReferrerFound(
  'utm_source=share&utm_content=AbC123xyz789',
);

/// Answers once [gate] completes, so a test can move the reader before the
/// referrer is known.
class _GatedReferrerSource implements InstallReferrerSource {
  _GatedReferrerSource(this.answer);

  final InstallReferrerAnswer answer;
  final gate = Completer<void>();

  @override
  Future<InstallReferrerAnswer> read() async {
    await gate.future;
    return answer;
  }
}

GoRouter _router(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(TomezaApp)),
  );
  return container.read(appRouterProvider);
}

/// The page on top — a pushed page leaves `currentConfiguration.uri` on the
/// page underneath it.
String _location(WidgetTester tester) =>
    _router(tester).routerDelegate.currentConfiguration.last.matchedLocation;

/// Frames in 100 ms steps: a focused composer's cursor never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late MemoryInstallAttributionStore store;
  late List<InstallAttribution> sent;

  InstallAttributionTracker tracker(InstallReferrerSource source) {
    return InstallAttributionTracker(
      source: source,
      store: store,
      report: (attribution) async {
        sent.add(attribution);
        return true;
      },
    );
  }

  InstallAttributionTracker answering(InstallReferrerAnswer answer) =>
      tracker(FakeReferrerSource([answer]));

  Widget app(
    InstallAttributionTracker attribution, {
    FakeAuthRepository? auth,
    FakeBookShareRepository? shares,
  }) {
    return testApp(
      authRepository: auth ?? FakeAuthRepository(initialSession: fakeSession()),
      projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
      billingRepository: FakeBillingRepository(billing: fakeBilling()),
      shareRepository:
          shares ?? FakeBookShareRepository(remix: lighthouseCat()),
      installAttribution: attribution,
    );
  }

  setUp(() {
    store = MemoryInstallAttributionStore();
    sent = [];
  });

  testWidgets('an install from a share is offered that share\'s remix on '
      'the real home, and opens it', (tester) async {
    final shares = FakeBookShareRepository(remix: lighthouseCat());
    await tester.pumpWidget(app(answering(_fromShare), shares: shares));
    await _settle(tester);

    expect(find.byType(CreationChatScreen), findsOneWidget);
    expect(find.text(_offerTitle), findsOneWidget);
    expect(sent.single.shareSlug, 'AbC123xyz789');

    await tester.tap(find.text('Make one like it'));
    await _settle(tester);

    expect(shares.remixSlugs, ['AbC123xyz789']);
  });

  testWidgets('the offer is shown once and the install reported once, '
      'whatever the reader answered', (tester) async {
    await tester.pumpWidget(app(answering(_fromShare)));
    await _settle(tester);
    await tester.tap(find.text('Not now'));
    await _settle(tester);
    expect(find.text(_offerTitle), findsNothing);
    expect(_location(tester), '/home');

    // Leaving home and coming back in the same session asks nothing again.
    _router(tester).go('/account');
    await _settle(tester);
    _router(tester).go('/home');
    await _settle(tester);
    expect(find.text(_offerTitle), findsNothing);

    // A later launch reads the same record.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(app(answering(_fromShare)));
    await _settle(tester);

    expect(find.text(_offerTitle), findsNothing);
    expect(sent, hasLength(1));
  });

  testWidgets('an install from anywhere else is reported and offered '
      'nothing', (tester) async {
    await tester.pumpWidget(
      app(
        answering(
          const InstallReferrerFound(
            'utm_source=google-play&utm_medium=organic',
          ),
        ),
      ),
    );
    await _settle(tester);

    expect(find.text(_offerTitle), findsNothing);
    expect(sent.single.source, 'google-play');
  });

  testWidgets('no referrer shows and sends nothing', (tester) async {
    await tester.pumpWidget(app(answering(const InstallReferrerNone())));
    await _settle(tester);

    expect(find.byType(CreationChatScreen), findsOneWidget);
    expect(find.text(_offerTitle), findsNothing);
    expect(sent, isEmpty);
  });

  testWidgets('a signed-out reader is asked nothing until they sign in', (
    tester,
  ) async {
    final source = FakeReferrerSource([_fromShare]);
    await tester.pumpWidget(app(tracker(source), auth: FakeAuthRepository()));
    await _settle(tester);
    expect(find.text('Welcome back'), findsOneWidget);
    expect(source.reads, 0);
    expect(sent, isEmpty);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'CorrectPass123',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await _settle(tester);

    expect(find.text(_offerTitle), findsOneWidget);
    expect(sent, hasLength(1));
  });

  testWidgets('a page opened over home keeps the offer until home is back on '
      'top', (tester) async {
    final source = _GatedReferrerSource(_fromShare);
    await tester.pumpWidget(app(tracker(source)));
    await _settle(tester);
    expect(_location(tester), '/home');

    // The reader moves on before Play has answered.
    unawaited(_router(tester).push('/account'));
    await _settle(tester);
    source.gate.complete();
    await _settle(tester);

    expect(_location(tester), '/account');
    expect(find.text(_offerTitle), findsNothing);
    // Reported as soon as it is known; only the offer waits for home.
    expect(sent, hasLength(1));
    expect(store.record?.remixOffered, isFalse);

    _router(tester).pop();
    await _settle(tester);

    expect(_location(tester), '/home');
    expect(find.text(_offerTitle), findsOneWidget);
    expect(sent, hasLength(1));
  });

  testWidgets('an offline session waits for the server before reporting or '
      'offering', (tester) async {
    final source = FakeReferrerSource([_fromShare]);
    await tester.pumpWidget(
      app(
        tracker(source),
        auth: FakeAuthRepository(
          initialSession: fakeSession(),
          offlineRestores: 1,
        ),
      ),
    );
    await _settle(tester);

    expect(
      find.byKey(const ValueKey('offline-session-notice')),
      findsOneWidget,
    );
    expect(source.reads, 0);
    expect(find.text(_offerTitle), findsNothing);

    await tester.pump(AuthController.offlineRevalidationDelays[0]);
    await _settle(tester);

    expect(find.byKey(const ValueKey('offline-session-notice')), findsNothing);
    expect(find.text(_offerTitle), findsOneWidget);
    expect(sent, hasLength(1));
  });
}
