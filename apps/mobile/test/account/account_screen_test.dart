import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/account/data/app_version.dart';
import 'package:tomeza/features/account/data/appearance_store.dart';
import 'package:tomeza/features/account/domain/appearance_prefs.dart';
import 'package:tomeza/features/account/presentation/account_plan_screen.dart';
import 'package:tomeza/features/account/presentation/account_privacy_screen.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/account/presentation/archived_chats_screen.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/author_profile.dart';
import 'package:tomeza/features/book_matter/presentation/author_profile_screen.dart';
import 'package:tomeza/features/notifications/data/push_device_repository.dart';
import 'package:tomeza/features/notifications/data/push_messaging.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';

import '../app/app_test_fixtures.dart';
import '../features/book_matter/fake_book_matter_repository.dart';
import '../features/notifications/fake_push_messaging.dart';

void main() {
  testWidgets('hub shows identity, balance, and every settings row', (
    tester,
  ) async {
    await _pumpHub(tester);

    expect(find.text('Mira'), findsOneWidget);
    expect(find.text('creator@example.com'), findsOneWidget);
    expect(find.textContaining('Member since'), findsOneWidget);
    expect(find.text('850'), findsOneWidget);
    expect(find.text('Free'), findsWidgets);
    expect(find.text('Free plan'), findsOneWidget);

    expect(find.byKey(const ValueKey('account-plan-row')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('account-credit-history')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('account-archived-chats')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('account-author-profile')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('account-appearance')), findsOneWidget);
    expect(find.byKey(const ValueKey('account-privacy-row')), findsOneWidget);
    expect(find.byKey(const ValueKey('account-support')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('account-privacy-policy')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('account-terms')), findsOneWidget);
    expect(find.byKey(const ValueKey('account-log-out')), findsOneWidget);

    expect(find.text('support@example.com'), findsOneWidget);
    expect(find.text('https://example.com/privacy'), findsOneWidget);
    expect(find.text('https://example.com/terms'), findsOneWidget);
    expect(find.text('Tomeza 1.0.0 (1)'), findsOneWidget);
  });

  testWidgets('a free account whose welcome grant the server is holding is '
      'told it is on its way', (tester) async {
    await _pumpHub(
      tester,
      billing: const MobileBilling(
        credits: CreditBalance(
          available: 0,
          reserved: 0,
          lifetimeGranted: 0,
          lifetimeSpent: 0,
        ),
        entitlements: [],
        products: [],
        creditCosts: {},
        freeTier: MobileFreeTier(welcomeCredits: 1000),
        welcomeCreditsPending: true,
      ),
    );

    expect(find.text('Your welcome credits are on their way.'), findsOneWidget);
    expect(find.textContaining('one-time welcome credits'), findsNothing);
  });

  testWidgets('a build that cannot send notifications shows no row for '
      'them', (tester) async {
    await _pumpHub(tester);
    expect(find.byKey(const ValueKey('account-notifications')), findsNothing);
  });

  testWidgets('notifications never asked for: the row asks the system, then '
      'files this install', (tester) async {
    final push = FakePushMessaging(currentPermission: PushPermission.notAsked);
    final devices = FakePushDeviceRepository();
    await _pumpHub(tester, push: push, pushDevices: devices);

    final row = find.byKey(const ValueKey('account-notifications'));
    expect(
      find.descendant(of: row, matching: find.text('Off')),
      findsOneWidget,
    );
    await tester.tap(row);
    await tester.pumpAndSettle();

    expect(push.permissionRequests, 1);
    expect(devices.calls, ['register fcm-token-1 android']);
    expect(find.descendant(of: row, matching: find.text('On')), findsOneWidget);
    expect(push.settingsOpened, 0);
  });

  testWidgets('notifications already decided: the row opens the phone\'s '
      'settings, where Android lets them change', (tester) async {
    for (final permission in [PushPermission.granted, PushPermission.denied]) {
      final push = FakePushMessaging(currentPermission: permission);
      await _pumpHub(tester, push: push);
      await tester.tap(find.byKey(const ValueKey('account-notifications')));
      await tester.pumpAndSettle();
      expect(push.settingsOpened, 1);
      expect(push.permissionRequests, 0);
    }
  });

  testWidgets('the overview card carries one action, and it is the upgrade', (
    tester,
  ) async {
    await _pumpHub(tester);

    expect(find.widgetWithText(FilledButton, 'Upgrade'), findsOneWidget);
    expect(find.text('Manage plan'), findsNothing);
    expect(find.text('Add credits'), findsNothing);
  });

  testWidgets('the deletion dialog sends nothing until it is confirmed', (
    tester,
  ) async {
    String? result = 'untouched';
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTomezaLightTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async => result = await showDialog<String>(
                context: context,
                builder: (_) => const AccountDeletionRequestDialog(),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(result, isNull);

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'moving on');
    await tester.tap(find.text('Send request'));
    await tester.pumpAndSettle();
    expect(result, 'moving on');
  });

  testWidgets('the plan row opens Plan & billing', (tester) async {
    await _pumpHub(tester);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('account-plan-row')),
      200,
    );
    await tester.tap(find.byKey(const ValueKey('account-plan-row')));
    await tester.pumpAndSettle();

    expect(find.byType(AccountPlanScreen), findsOneWidget);
    expect(find.text('Plan & billing'), findsWidgets);
  });

  testWidgets('the author profile row opens Author profile', (tester) async {
    await _pumpHub(tester);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('account-author-profile')),
      200,
    );
    await tester.tap(find.byKey(const ValueKey('account-author-profile')));
    await tester.pumpAndSettle();

    expect(find.byType(AuthorProfileScreen), findsOneWidget);
    expect(find.text('Pen name'), findsOneWidget);
  });

  testWidgets('appearance sheet persists the chosen mode', (tester) async {
    final store = MemoryAppearanceStore();
    await _pumpHub(tester, appearance: store);

    expect(find.text('System'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('account-appearance')),
      200,
    );
    await tester.tap(find.byKey(const ValueKey('account-appearance')));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Dark'));
    await tester.pumpAndSettle();

    expect(await store.load(), AppearanceMode.dark);
    expect(find.text('Dark'), findsOneWidget);
    expect(find.text('Always use a dark theme'), findsNothing);
  });

  testWidgets('hub renders in the dark theme', (tester) async {
    await _pumpHub(tester, dark: true);
    expect(find.text('Account'), findsOneWidget);
    expect(find.text('Mira'), findsOneWidget);
    expect(find.byKey(const ValueKey('account-plan-row')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('log out asks for confirmation before signing out', (
    tester,
  ) async {
    final auth = _RecordingAuthRepository(initialSession: fakeSession());
    await _pumpHub(tester, auth: auth);

    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('account-log-out')),
      200,
    );
    await tester.tap(find.byKey(const ValueKey('account-log-out')));
    await tester.pumpAndSettle();
    expect(find.text('Log out of this device?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(auth.logouts, 0);

    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('account-log-out')),
      200,
    );
    await tester.tap(find.byKey(const ValueKey('account-log-out')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Log out'));
    await tester.pumpAndSettle();
    expect(auth.logouts, 1);
  });
}

class _RecordingAuthRepository extends FakeAuthRepository {
  _RecordingAuthRepository({super.initialSession});

  int logouts = 0;

  @override
  Future<void> logout() async {
    logouts += 1;
    await super.logout();
  }
}

Future<void> _pumpHub(
  WidgetTester tester, {
  AppearanceStore? appearance,
  AuthRepository? auth,
  PushMessaging? push,
  PushDeviceRepository? pushDevices,
  MobileBilling? billing,
  bool dark = false,
}) async {
  final router = GoRouter(
    initialLocation: '/account',
    routes: [
      GoRoute(path: '/account', builder: (_, _) => const AccountScreen()),
      GoRoute(
        path: '/account/plan',
        builder: (_, _) => const AccountPlanScreen(),
      ),
      GoRoute(
        path: '/account/archived-chats',
        builder: (_, _) => const ArchivedChatsScreen(),
      ),
      GoRoute(
        path: '/account/credit-history',
        builder: (_, _) => const Scaffold(body: SizedBox.shrink()),
      ),
      GoRoute(
        path: authorProfileLocation,
        builder: (_, _) => const AuthorProfileScreen(),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.binding.setSurfaceSize(const Size(800, 2000));
  addTearDown(() => tester.binding.setSurfaceSize(null));

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(
          auth ?? FakeAuthRepository(initialSession: fakeSession()),
        ),
        billingRepositoryProvider.overrideWithValue(
          FakeBillingRepository(billing: billing),
        ),
        appearanceStoreProvider.overrideWithValue(
          appearance ?? MemoryAppearanceStore(),
        ),
        appVersionProvider.overrideWith((ref) async => 'Tomeza 1.0.0 (1)'),
        appConfigProvider.overrideWithValue(_testConfig),
        projectsRepositoryProvider.overrideWithValue(FakeProjectsRepository()),
        creationRepositoryProvider.overrideWithValue(FakeCreationRepository()),
        bookMatterRepositoryProvider.overrideWithValue(
          FakeBookMatterRepository(
            profile: const AuthorProfile(suggestedPenName: 'Mira'),
          ),
        ),
        if (push != null) pushMessagingProvider.overrideWithValue(push),
        if (pushDevices != null)
          pushDeviceRepositoryProvider.overrideWithValue(pushDevices),
      ],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        darkTheme: buildTomezaDarkTheme(),
        themeMode: dark ? ThemeMode.dark : ThemeMode.light,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

final _testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://10.0.2.2:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete-account'),
  supportEmail: 'support@example.com',
);
