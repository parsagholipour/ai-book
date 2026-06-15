import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/new_book_wizard_screen.dart';

void main() {
  testWidgets('new book wizard validates prompt before project creation', (
    tester,
  ) async {
    final repository = FakeProjectsRepository();

    await tester.pumpWidget(testWizardApp(repository));

    expect(find.text('Choose a book type'), findsOneWidget);

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(find.text('Describe the book'), findsOneWidget);

    await tester.tap(find.text('Continue'));
    await tester.pump();

    expect(
      find.text('Describe the book in at least 10 characters.'),
      findsOneWidget,
    );
    expect(repository.lastCreateRequest, isNull);
  });

  testWidgets('new book wizard submits buyer-facing presets', (tester) async {
    final repository = FakeProjectsRepository();

    await tester.pumpWidget(testWizardApp(repository));

    await tester.tap(find.text('Workbook or study guide'));
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'Class Plan');
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'Create a practical workbook for first-time online teachers.',
    );
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Expanded'));
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Extra polish'));
    await tester.tap(find.text('Create project'));
    await tester.pumpAndSettle();

    expect(repository.lastCreateRequest, isNotNull);
    expect(repository.lastCreateRequest!.bookType, 'workbook');
    expect(repository.lastCreateRequest!.title, 'Class Plan');
    expect(repository.lastCreateRequest!.lengthPreset, 'expanded');
    expect(repository.lastCreateRequest!.qualityPreset, 'premium');
    expect(repository.lastCreateRequest!.imagesEnabled, isTrue);
    expect(find.text('Created project project-created'), findsOneWidget);
  });
}

Widget testWizardApp(FakeProjectsRepository repository) {
  final router = GoRouter(
    initialLocation: '/books/new',
    routes: [
      GoRoute(
        path: '/books/new',
        builder: (context, state) => const NewBookWizardScreen(),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            Text('Created project ${state.pathParameters['id']}'),
      ),
    ],
  );

  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp.router(routerConfig: router),
  );
}

class FakeProjectsRepository implements ProjectsRepository {
  MobileProjectCreateRequest? lastCreateRequest;

  @override
  Future<MobileProjectDetail> createProject(
    MobileProjectCreateRequest request,
  ) async {
    lastCreateRequest = request;
    return fakeProjectDetail(id: 'project-created');
  }

  @override
  Future<MobilePlanOperation> approvePlan(String planId) async {
    return fakeOperation(status: 'generation_queued', planId: planId);
  }

  @override
  Future<Map<String, String>> assetHeaders() async {
    return const {};
  }

  @override
  Future<ProjectDeletionReceipt> deleteProject(String id) async {
    return ProjectDeletionReceipt(
      deletedProjectId: id,
      retainedLogs: 'Retained safety records.',
    );
  }

  @override
  Future<MobilePlanOperation> generatePlan(String projectId) async {
    return fakeOperation(projectId: projectId, status: 'planning_queued');
  }

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    return fakeProjectDetail(id: id);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return fakeProjectStatus(projectId: id);
  }

  @override
  Future<List<MobileProjectSummary>> listProjects() async {
    return const [];
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    return ProjectExportFile(
      format: export.format,
      filename: export.filename,
      path: '/tmp/${export.filename}',
    );
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
  }) async {
    return fakeOperation(status: 'revision_queued', planId: planId);
  }

  @override
  Future<MobileProjectRecovery> resumeProject(String id) async {
    return MobileProjectRecovery(
      projectId: id,
      status: 'recovery_started',
      currentAction: 'Retrying generation.',
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0,
    );
  }

  @override
  Future<ModerationReportReceipt> reportAsset({
    required String projectId,
    required String assetId,
    required String reason,
    String? comment,
  }) async {
    return fakeReportReceipt(targetType: 'image_asset', reason: reason);
  }

  @override
  Future<ModerationReportReceipt> reportProject({
    required String projectId,
    required String reason,
    String? comment,
  }) async {
    return fakeReportReceipt(targetType: 'project', reason: reason);
  }

  @override
  Future<void> shareExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {}
}

ModerationReportReceipt fakeReportReceipt({
  required String targetType,
  required String reason,
}) {
  return ModerationReportReceipt(
    id: 'report-1',
    targetType: targetType,
    reason: reason,
    status: 'pending',
    createdAt: DateTime.utc(2026, 6, 15),
  );
}

MobileProjectDetail fakeProjectDetail({required String id}) {
  return MobileProjectDetail(
    id: id,
    title: 'Class Plan',
    bookType: 'workbook',
    lengthPreset: 'expanded',
    qualityPreset: 'premium',
    imagesEnabled: true,
    status: 'draft',
    statusLabel: 'Draft saved',
    progressPercent: 0,
    currentAction: 'Ready to create a book plan.',
    promptPreview: 'Create a practical workbook.',
    targetPages: 40,
    pageCount: 0,
    imageCount: 0,
    hasPlan: false,
    exports: fakeExports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a practical workbook for first-time online teachers.',
    language: 'en',
    pages: const [],
  );
}

MobilePlanOperation fakeOperation({
  String projectId = 'project-created',
  required String status,
  String? planId,
}) {
  return MobilePlanOperation(
    projectId: projectId,
    planId: planId,
    status: status,
    currentAction: 'Working on the plan.',
    job: const MobileQueuedJob(
      id: 'job-1',
      status: 'queued',
      currentAction: 'Working on the plan.',
    ),
  );
}

MobileProjectStatus fakeProjectStatus({required String projectId}) {
  return MobileProjectStatus(
    projectId: projectId,
    status: 'draft',
    statusLabel: 'Draft saved',
    progressPercent: 0,
    currentAction: 'Ready to create a book plan.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 0, target: 40),
    imageCount: 0,
    exports: fakeExports,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

const fakeExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-created/export/pdf',
    filename: 'Class-Plan.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-created/export/epub',
    filename: 'Class-Plan.epub',
    contentType: 'application/epub+zip',
  ),
);
