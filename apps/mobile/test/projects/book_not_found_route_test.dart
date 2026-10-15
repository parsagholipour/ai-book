import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../app/app_test_fixtures.dart';

/// A book that was deleted, or never this account's.
class _MissingBookRepository extends FakeProjectsRepository {
  @override
  Future<MobileProjectDetail> getProject(String id) async {
    throw const ApiException(
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.',
      statusCode: 404,
    );
  }
}

void main() {
  testWidgets('missing project route returns users to home', (tester) async {
    final router = GoRouter(
      initialLocation: '/projects/missing',
      routes: [
        GoRoute(
          path: '/home',
          builder: (context, state) =>
              const Scaffold(body: Text('Useful home')),
        ),
        GoRoute(
          path: '/projects/:id',
          builder: (context, state) =>
              BookScreen(projectId: state.pathParameters['id']!),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectsRepositoryProvider.overrideWithValue(
            _MissingBookRepository(),
          ),
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        ],
        child: MaterialApp.router(
          theme: buildTomezaLightTheme(),
          routerConfig: router,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Book not found'), findsOneWidget);
    expect(find.text('Back to projects'), findsOneWidget);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Back to projects'));
    await tester.pumpAndSettle();

    expect(find.text('Useful home'), findsOneWidget);
  });
}
