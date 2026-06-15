import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

void main() {
  testWidgets('auth gate routes signed-out users to sign in and sign up', (
    tester,
  ) async {
    await tester.pumpWidget(testApp(authRepository: FakeAuthRepository()));

    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);

    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(find.text('Create your account'), findsOneWidget);
    expect(find.text('I already have an account'), findsOneWidget);
  });

  testWidgets(
    'authenticated users land on projects home with placeholder action',
    (tester) async {
      await tester.pumpWidget(
        testApp(
          authRepository: FakeAuthRepository(initialSession: fakeSession()),
          projectsRepository: FakeProjectsRepository(projects: [fakeProject()]),
          billingRepository: FakeBillingRepository(billing: fakeBilling()),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('Your book projects'), findsOneWidget);
      expect(find.text('Credits'), findsOneWidget);
      expect(find.text('Audience Growth Workbook'), findsOneWidget);
      expect(find.text('Create your account'), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'New'));
      await tester.pump();

      expect(find.text('New book setup is not available yet.'), findsOneWidget);
    },
  );
}

Widget testApp({
  required FakeAuthRepository authRepository,
  FakeProjectsRepository? projectsRepository,
  FakeBillingRepository? billingRepository,
}) {
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(authRepository),
      projectsRepositoryProvider.overrideWithValue(
        projectsRepository ?? FakeProjectsRepository(),
      ),
      billingRepositoryProvider.overrideWithValue(
        billingRepository ?? FakeBillingRepository(),
      ),
    ],
    child: const TomezaApp(),
  );
}

class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({AuthSession? initialSession}) : _session = initialSession;

  AuthSession? _session;

  @override
  Future<AuthSession?> restoreSession() async => _session;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    _session = fakeSession(email: email);
    return _session!;
  }

  @override
  Future<AuthSession> signUp({
    required String email,
    required String password,
    String? displayName,
  }) async {
    _session = fakeSession(email: email, displayName: displayName);
    return _session!;
  }

  @override
  Future<void> logout() async {
    _session = null;
  }
}

class FakeProjectsRepository implements ProjectsRepository {
  FakeProjectsRepository({List<MobileProjectSummary>? projects})
    : _projects = projects ?? [];

  final List<MobileProjectSummary> _projects;

  @override
  Future<List<MobileProjectSummary>> listProjects() async => _projects;
}

class FakeBillingRepository implements BillingRepository {
  FakeBillingRepository({MobileBilling? billing})
    : _billing = billing ?? fakeBilling();

  final MobileBilling _billing;

  @override
  Future<MobileBilling> getBilling() async => _billing;
}

AuthSession fakeSession({
  String email = 'creator@example.com',
  String? displayName = 'Mira',
}) {
  return AuthSession(
    user: AuthUser(
      id: 'user-1',
      email: email,
      displayName: displayName,
      status: 'ACTIVE',
      createdAt: DateTime.utc(2026, 6, 1),
      updatedAt: DateTime.utc(2026, 6, 1),
    ),
    tokens: MobileSessionTokens(
      accessToken: 'access-token',
      accessTokenExpiresAt: DateTime.utc(2999, 1, 1),
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: DateTime.utc(2999, 2, 1),
    ),
  );
}

MobileProjectSummary fakeProject() {
  return MobileProjectSummary(
    id: 'project-1',
    title: 'Audience Growth Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'draft',
    statusLabel: 'Draft saved',
    progressPercent: 0,
    currentAction: 'Ready to create a book plan.',
    promptPreview:
        'Create a workbook for independent teachers building a simple audience funnel.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: false,
    exports: const MobileExportSet(
      pdf: MobileExportAvailability(
        format: 'pdf',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '/api/mobile/projects/project-1/export/pdf',
        filename: 'Audience-Growth-Workbook.pdf',
        contentType: 'application/pdf',
      ),
      epub: MobileExportAvailability(
        format: 'epub',
        available: false,
        unlocked: false,
        creditsRequired: 150,
        downloadUrl: '/api/mobile/projects/project-1/export/epub',
        filename: 'Audience-Growth-Workbook.epub',
        contentType: 'application/epub+zip',
      ),
    ),
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: DateTime.utc(2026, 6, 1),
  );
}

MobileBilling fakeBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 850,
      reserved: 150,
      lifetimeGranted: 1000,
      lifetimeSpent: 150,
    ),
    entitlements: [],
    products: [],
    creditCosts: {},
  );
}
