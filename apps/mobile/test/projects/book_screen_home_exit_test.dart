import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/routing/exit_confirmation.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';

import 'book_page_fixtures.dart';

// An import lands on the book with `go`, and so does leaving the Writing
// Studio after a takeover: nothing is beneath the book page. Its bar used to
// have no way out, and Android back offered to close the app.
void main() {
  late List<MethodCall> platformCalls;

  setUp(() {
    platformCalls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          platformCalls.add(call);
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  testWidgets('a book page with nothing beneath it offers a way home', (
    tester,
  ) async {
    await tester.pumpWidget(_app(initialLocation: '/projects/project-1'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('book-home')), findsOneWidget);
    expect(find.byTooltip('Home'), findsOneWidget);

    await tester.tap(find.byKey(const Key('book-home')));
    await tester.pumpAndSettle();

    expect(find.text('Home screen'), findsOneWidget);
  });

  testWidgets('Android back on that page goes home instead of asking to '
      'close the app', (tester) async {
    await tester.pumpWidget(_app(initialLocation: '/projects/project-1'));
    await tester.pumpAndSettle();

    final handled = await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.text('Close Tomeza?'), findsNothing);
    expect(find.text('Home screen'), findsOneWidget);
    expect(handled, isTrue);
    expect(
      platformCalls.where((call) => call.method == 'SystemNavigator.pop'),
      isEmpty,
    );
  });

  testWidgets('a book page pushed over home keeps the ordinary back arrow', (
    tester,
  ) async {
    await tester.pumpWidget(_app(initialLocation: '/home'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Open book'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('book-home')), findsNothing);
    expect(find.byType(BackButton), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.text('Home screen'), findsOneWidget);
    expect(find.text('Close Tomeza?'), findsNothing);
  });
}

Widget _app({required String initialLocation}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/home',
        builder: (context, state) => Scaffold(
          appBar: AppBar(title: const Text('Home screen')),
          body: TextButton(
            onPressed: () => context.push('/projects/project-1'),
            child: const Text('Open book'),
          ),
        ),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            BookScreen(projectId: state.pathParameters['id']!),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(_BookRepository()),
      billingProvider.overrideWith(
        (ref) => Future<MobileBilling>.value(creditsBilling),
      ),
    ],
    child: MaterialApp.router(
      routerDelegate: router.routerDelegate,
      routeInformationParser: router.routeInformationParser,
      routeInformationProvider: router.routeInformationProvider,
      backButtonDispatcher: ConfirmExitBackButtonDispatcher(
        router.routerDelegate.navigatorKey,
      ),
    ),
  );
}

class _BookRepository implements ProjectsRepository {
  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) =>
      Stream.value(bookStatus());

  @override
  Future<MobileProjectDetail> getProject(String id) async => bookProject();

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async => const MobileProjectChat(messages: [], operations: []);

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
