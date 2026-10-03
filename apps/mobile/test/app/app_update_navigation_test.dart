import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/app_update/domain/app_update.dart';

import 'app_test_fixtures.dart';

const _required = AppUpdateStatus(
  action: AppUpdateAction.required,
  latestBuild: 9,
  latestVersion: '1.2.0',
  message: 'This update fixes purchases on some phones.',
);

AppUpdateStatus _prompt(int build) => AppUpdateStatus(
  action: AppUpdateAction.prompt,
  latestBuild: build,
  latestVersion: '1.$build.0',
);

void _setStatus(WidgetTester tester, AppUpdateStatus status) {
  ProviderScope.containerOf(
    tester.element(find.byType(TomezaApp)),
  ).read(appUpdateStatusProvider.notifier).update(status);
}

Widget _signedInApp() => testApp(
  authRepository: FakeAuthRepository(initialSession: fakeSession()),
  projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
  billingRepository: FakeBillingRepository(billing: fakeBilling()),
);

void main() {
  testWidgets('a required update takes over the app and lets go of it', (
    tester,
  ) async {
    await tester.pumpWidget(_signedInApp());
    await tester.pumpAndSettle();
    expect(find.text('Practical guide'), findsOneWidget);

    _setStatus(tester, _required);
    await tester.pumpAndSettle();

    expect(find.text('Update Tomeza to keep going'), findsOneWidget);
    expect(
      find.text('This update fixes purchases on some phones.'),
      findsOneWidget,
    );
    expect(find.text('Version 1.2.0 is available.'), findsOneWidget);
    expect(find.text('Practical guide'), findsNothing);

    // The operator relaxed the policy: the next check lets the reader back in.
    _setStatus(tester, AppUpdateStatus.none);
    await tester.pumpAndSettle();

    expect(find.text('Update Tomeza to keep going'), findsNothing);
    expect(find.text('Practical guide'), findsOneWidget);
  });

  testWidgets('a signed-out build is gated before sign in', (tester) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);

    _setStatus(tester, _required);
    await tester.pumpAndSettle();

    expect(find.text('Update Tomeza to keep going'), findsOneWidget);
    expect(find.text('Welcome back'), findsNothing);
  });

  testWidgets('an optional update is offered once per release', (tester) async {
    await tester.pumpWidget(_signedInApp());
    await tester.pumpAndSettle();

    _setStatus(tester, _prompt(9));
    await tester.pumpAndSettle();

    expect(find.text('A new version of Tomeza is ready'), findsOneWidget);
    expect(find.text('Version 1.9.0'), findsOneWidget);

    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(find.text('A new version of Tomeza is ready'), findsNothing);
    expect(find.text('Practical guide'), findsOneWidget);

    // The same release, answered again on the next resume: not asked twice.
    _setStatus(tester, AppUpdateStatus.none);
    _setStatus(tester, _prompt(9));
    await tester.pumpAndSettle();
    expect(find.text('A new version of Tomeza is ready'), findsNothing);

    // A newer release asks again.
    _setStatus(tester, _prompt(10));
    await tester.pumpAndSettle();
    expect(find.text('A new version of Tomeza is ready'), findsOneWidget);
    expect(find.text('Version 1.10.0'), findsOneWidget);
  });
}
