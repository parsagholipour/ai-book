import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_screen.dart';
import 'package:tomeza/features/projects/presentation/book_screen_skeleton.dart';
import 'package:tomeza/shared/api/api_client.dart';

import 'book_page_fixtures.dart';
import 'plan_projects_repository_fake.dart';

// Before the book has arrived, the page is the shape of a book — not a spinner
// over nothing — and it hands over to the real page when the data lands.

class _Gated extends PlanProjectsRepository {
  _Gated() : super(project: bookProject(), status: bookStatus());

  final gate = Completer<void>();

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    await gate.future;
    return super.getProject(id);
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    await gate.future;
    yield* super.watchProjectStatus(id);
  }
}

void main() {
  testWidgets('a book that has not loaded shows its shape, then the book', (
    tester,
  ) async {
    final repository = _Gated();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(
            AppConfig(
              environment: AppEnvironment.local,
              apiBaseUrl: Uri.parse('http://localhost:4001'),
              privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
              termsOfServiceUrl: Uri.parse('https://example.com/terms'),
              accountDeletionUrl: Uri.parse('https://example.com/delete'),
              supportEmail: 'support@example.com',
            ),
          ),
          apiAuthHeadersProvider.overrideWith(
            (ref) async => const <String, String>{},
          ),
          projectsRepositoryProvider.overrideWithValue(repository),
          billingProvider.overrideWith((ref) async => creditsBilling),
        ],
        child: const MaterialApp(home: BookScreen(projectId: 'project-1')),
      ),
    );
    await tester.pump();

    expect(find.byType(BookScreenSkeleton), findsOneWidget);
    expect(find.bySemanticsLabel('Opening your book'), findsOneWidget);
    expect(find.text('Read'), findsNothing);

    repository.gate.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(find.byType(BookScreenSkeleton), findsNothing);
    expect(find.text('Read'), findsOneWidget);
  });
}
