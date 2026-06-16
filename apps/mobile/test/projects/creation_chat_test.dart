import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';

const _greeting = 'Tell me about the book you want to make.';
const _reply = 'Great, that is enough for a solid first plan.';
const _planTitle = 'Launch Course Workbook';

void main() {
  testWidgets('greeting and quick replies render; build is gated until ready', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text(_greeting), findsOneWidget);
    expect(find.text('A kids book'), findsOneWidget);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNull);

    await tester.teardownScreen();
  });

  testWidgets('replying enables build and records the message', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages, contains('A kids book'));
    expect(find.text(_reply), findsOneWidget);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNotNull);

    await tester.teardownScreen();
  });

  testWidgets('advanced sheet overrides the book type with a Your choice badge', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();

    expect(find.text('Advanced settings'), findsOneWidget);
    await tester.tap(find.text('Workbook').first);
    await tester.pumpAndSettle();

    expect(find.text('Your choice'), findsWidgets);

    final doneButton = find.widgetWithText(FilledButton, 'Done');
    await tester.ensureVisible(doneButton);
    await tester.tap(doneButton);
    await tester.pumpAndSettle();

    await tester.teardownScreen();
  });

  testWidgets('building shows the generated plan in-chat', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(
      _app(creation: creation, projects: _PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildDraftId, 'draft-1');
    expect(find.text('Book plan'), findsWidgets);
    expect(find.text(_planTitle), findsOneWidget);

    await tester.teardownScreen();
  });
}

extension on WidgetTester {
  /// Tears down the screen so its polling timer and tickers are cancelled.
  Future<void> teardownScreen() async {
    await pumpWidget(const SizedBox());
    await pump();
  }
}

Widget _app({
  required _ScriptedCreationRepository creation,
  ProjectsRepository? projects,
}) {
  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(creation),
      if (projects != null)
        projectsRepositoryProvider.overrideWithValue(projects),
      billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: const CreationChatScreen(),
    ),
  );
}

Map<String, dynamic> _turnJson({
  required String assistantMessage,
  required bool canBuild,
  List<String> quickReplies = const [],
}) {
  return {
    'assistantMessage': assistantMessage,
    'brief': {'lane': 'practical_guide'},
    'presets': {
      'bookType': 'lead_magnet',
      'lengthPreset': 'short',
      'qualityPreset': 'balanced',
      'imagesEnabled': true,
    },
    'detectedLane': 'practical_guide',
    'quickReplies': quickReplies,
    'question': null,
    'readiness': {
      'score': canBuild ? 80 : 10,
      'canBuild': canBuild,
      'missing': <dynamic>[],
    },
    'titleSuggestions': <dynamic>[],
    'shapePreview': ['Intro'],
    'warnings': <dynamic>[],
  };
}

class _ScriptedCreationRepository implements CreationRepository {
  final sentMessages = <String>[];
  MobileCreationPresets? buildPresets;
  String? buildDraftId;

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    return MobileCreationConversationResponse.fromJson({
      'turn': _turnJson(
        assistantMessage: _greeting,
        canBuild: false,
        quickReplies: const ['A kids book', 'A workbook'],
      ),
    });
  }

  @override
  Future<MobileCreationConversationResponse> startConversation() async {
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'status': 'ACTIVE',
        'messages': [
          {'role': 'assistant', 'content': _greeting},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: _greeting,
        canBuild: false,
        quickReplies: const ['A kids book', 'A workbook'],
      ),
    });
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
  }) async {
    sentMessages.add(message);
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'status': 'ACTIVE',
        'messages': [
          {'role': 'assistant', 'content': _greeting},
          {'role': 'user', 'content': message},
          {'role': 'assistant', 'content': _reply},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: _reply,
        canBuild: true,
        quickReplies: const ['Make it shorter'],
      ),
    });
  }

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    buildDraftId = draftId;
    buildPresets = presets;
    return MobileCreationFinalizeResponse(
      project: _plannedProject(),
      operation: MobilePlanOperation(
        projectId: 'project-1',
        planId: 'plan-1',
        status: 'planning_queued',
        currentAction: 'Building your plan.',
        job: const MobileQueuedJob(
          id: 'job-1',
          status: 'queued',
          currentAction: 'Building your plan.',
        ),
      ),
    );
  }

  @override
  Future<MobileCreationDraft?> getActiveDraft() async => null;

  @override
  Future<MobileCreationDraft> createDraft(MobileCreationDraftPayload payload) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  ) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) {
    throw UnimplementedError();
  }
}

class _PlanProjectsRepository implements ProjectsRepository {
  @override
  Future<MobileProjectDetail> getProject(String id) async => _plannedProject();

  @override
  Future<List<MobileProjectSummary>> listProjects() async => const [];

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => _billing();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectDetail _plannedProject() {
  return MobileProjectDetail(
    id: 'project-1',
    title: _planTitle,
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: 'plan_ready',
    statusLabel: 'Review your book plan',
    progressPercent: 20,
    currentAction: 'Ready for review.',
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: true,
    exports: _exports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: _plan(),
    pages: const [],
  );
}

MobilePlan _plan() {
  return MobilePlan(
    id: 'plan-1',
    projectId: 'project-1',
    version: 1,
    status: 'draft',
    title: _planTitle,
    premise: 'A practical workbook for a simple paid launch.',
    audience: 'Independent teachers and coaches.',
    questions: const [],
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        targetPages: 8,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileBilling _billing() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 1200,
      reserved: 0,
      lifetimeGranted: 1200,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [],
    creditCosts: {
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

const _exports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);
