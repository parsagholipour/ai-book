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
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/account/presentation/archived_chats_screen.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';

import '../app/app_test_fixtures.dart';

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
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        appearanceStoreProvider.overrideWithValue(
          appearance ?? MemoryAppearanceStore(),
        ),
        appVersionProvider.overrideWith((ref) async => 'Tomeza 1.0.0 (1)'),
        appConfigProvider.overrideWithValue(_testConfig),
        projectsRepositoryProvider.overrideWithValue(FakeProjectsRepository()),
        creationRepositoryProvider.overrideWithValue(FakeCreationRepository()),
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
