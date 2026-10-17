// The creation chat with a book past its plan: the stubs and the pump that
// the generation-progress tests share.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/characters/data/characters_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/making_of_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'chat_session_page_fixture.dart';
import 'making_of_stub.dart';

MobileProjectDetail generationDetail({
  String status = 'generating',
  MobilePlan? plan,
}) {
  return MobileProjectDetail(
    id: 'project-1',
    title: 'Launch Course Workbook',
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: 'Generating your book',
    progressPercent: 38,
    currentAction: 'Writing your book.',
    promptPreview: 'Create a workbook.',
    targetPages: 28,
    pageCount: 3,
    imageCount: 1,
    hasPlan: plan != null,
    exports: generationExports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook.',
    language: 'en',
    plan: plan,
    pages: const [],
  );
}

/// Pumps far enough for the crossfades and the eased bar, but never waits for
/// the step spinner — that animation is continuous by design.
Future<void> settleEnough(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> pumpGenerationChat(
  WidgetTester tester, {
  MobileProjectStatus? status,
  Stream<MobileProjectStatus>? statusStream,
  StubGenerationProjectsRepository? projects,
  StubGenerationBillingRepository? billing,
  MakingOfRepository? makingOf,
  CharactersRepository? characters,
}) async {
  final repository =
      projects ??
      StubGenerationProjectsRepository(
        status: status,
        statusStream: statusStream,
      );
  final router = GoRouter(
    initialLocation: '/books/chat/draft-done',
    routes: [
      GoRoute(
        path: '/books/chat/:draftId',
        builder: (context, state) =>
            CreationChatScreen(draftId: state.pathParameters['draftId']),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            Scaffold(body: Text('Book route ${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: '/projects/:id/read',
        builder: (context, state) => Scaffold(
          body: Text('Reader at page ${state.uri.queryParameters['page']}'),
        ),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(
          StubGenerationCreationRepository(),
        ),
        projectsRepositoryProvider.overrideWithValue(repository),
        makingOfRepositoryProvider.overrideWithValue(
          makingOf ?? StubMakingOfRepository(),
        ),
        charactersRepositoryProvider.overrideWithValue(
          characters ?? LibraryOnlyCharactersRepository(),
        ),
        billingRepositoryProvider.overrideWithValue(
          billing ?? StubGenerationBillingRepository(),
        ),
      ],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        routerConfig: router,
      ),
    ),
  );
  await settleEnough(tester);
}

MobileProjectStatus generationStatus({
  String status = 'generating',
  String? statusLabel,
  int progressPercent = 38,
  String currentAction = 'Writing your book pages.',
  MobileGenerationProgress? generationProgress,
  MobileGenerationProgress? editProgress,
  bool coverEnabled = true,
  bool illustrationsEnabled = true,
  String? failureMessage,
  bool retryAvailable = false,
  DateTime? nextRetryAt,
  String? retryState,
  String? retryMessage,
  int? planningDurationMs,
  int? bookGenerationDurationMs,
  MobileExportSet exports = generationExports,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: statusLabel ?? 'Generating your book',
    progressPercent: progressPercent,
    currentAction: currentAction,
    generationProgress: generationProgress,
    editProgress: editProgress,
    failureMessage: failureMessage,
    retryAvailable: retryAvailable,
    nextRetryAt: nextRetryAt,
    retryState: retryState,
    retryMessage: retryMessage,
    recoveryQuote: retryAvailable
        ? const MobileGenerationRecoveryQuote(
            retryToken: 'confirmed-retry-token',
            credits: 40,
          )
        : null,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 3, target: 28),
    imageCount: 1,
    exports: exports,
    planningDurationMs: planningDurationMs,
    bookGenerationDurationMs: bookGenerationDurationMs,
    coverEnabled: coverEnabled,
    illustrationsEnabled: illustrationsEnabled,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

const generationExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

const readyGenerationExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

class StubGenerationProjectsRepository implements ProjectsRepository {
  StubGenerationProjectsRepository({
    this.status,
    this.statusStream,
    this.detailBuilder,
  });

  final MobileProjectStatus? status;
  final Stream<MobileProjectStatus>? statusStream;

  /// Builds the detail for each `getProject` call, so a test can hand back a
  /// book that changes underneath the screen the way a real one does.
  final MobileProjectDetail Function(int call)? detailBuilder;
  final List<String> resumedProjectIds = [];
  int detailFetches = 0;

  @override
  Future<MobileProjectRecovery> resumeProject(
    String id, {
    String? requestId,
    String? retryToken,
  }) async {
    resumedProjectIds.add(id);
    return const MobileProjectRecovery(
      projectId: 'project-1',
      status: 'generating',
      currentAction: 'Picking your book back up.',
      resumedActions: 1,
      skippedActions: 0,
      stoppingActions: 0,
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) {
    final stream = statusStream;
    if (stream != null) {
      return stream;
    }
    final value = status ?? generationStatus();
    // The server holds the connection open for as long as the book is live and
    // closes it the moment it settles — and a stream that ends early is exactly
    // what makes the client fall back to polling. Closing one here on a live
    // book would leave that poll's timer pending past the end of the test.
    return value.isLive
        ? Stream<MobileProjectStatus>.multi(
            (controller) => controller.add(value),
          )
        : Stream.value(value);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return status ?? generationStatus();
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String projectId, {
    String? beforeMessageId,
    int limit = 50,
  }) async {
    return const MobileProjectChat(messages: [], operations: []);
  }

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    final call = detailFetches++;
    final build = detailBuilder;
    if (build != null) {
      return build(call);
    }
    return MobileProjectDetail(
      id: 'project-1',
      title: 'Launch Course Workbook',
      bookType: 'workbook',
      lengthPreset: 'standard',
      qualityPreset: 'balanced',
      imagesEnabled: true,
      status: status?.status ?? 'generating',
      statusLabel: 'Generating your book',
      progressPercent: 38,
      currentAction: 'Writing your book.',
      promptPreview: 'Create a workbook.',
      targetPages: 28,
      pageCount: 3,
      imageCount: 1,
      hasPlan: true,
      exports: generationExports,
      createdAt: DateTime.utc(2026, 6, 15),
      updatedAt: DateTime.utc(2026, 6, 15),
      prompt: 'Create a workbook.',
      language: 'en',
      plan: MobilePlan(
        id: 'plan-1',
        projectId: 'project-1',
        version: 1,
        status: 'approved',
        title: 'Launch Course Workbook',
        premise: 'A practical workbook.',
        audience: 'Teachers',
        chapters: const [
          MobilePlanChapter(
            index: 1,
            title: 'Getting started',
            summary: 'Why this matters.',
            targetPages: 4,
          ),
        ],
        questions: const [],
        createdAt: DateTime.utc(2026, 6, 15),
        updatedAt: DateTime.utc(2026, 6, 15),
      ),
      pages: const [],
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class StubGenerationCreationRepository
    with ListSessionsPageFromList
    implements CreationRepository {
  @override
  Future<List<MobileChatSession>> listSessions() async {
    return [
      MobileChatSession(
        draftId: 'draft-done',
        title: 'Completed idea',
        preview: 'Latest message',
        messageCount: 2,
        status: 'COMPLETED',
        createdProjectId: 'project-1',
        activeProjectId: 'project-1',
        createdAt: DateTime.utc(2026, 6, 15),
        updatedAt: DateTime.utc(2026, 6, 15),
      ),
    ];
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': draftId,
        'title': 'Completed idea',
        'status': 'COMPLETED',
        'messages': [
          {'role': 'assistant', 'content': 'Original completed transcript'},
        ],
        'createdProjectId': 'project-1',
        'activeProjectId': 'project-1',
        'outputs': <dynamic>[],
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson,
    });
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    return MobileCreationConversationResponse.fromJson({'turn': _turnJson});
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

const _turnJson = {
  'assistantMessage': 'Original completed transcript',
  'brief': {'lane': 'auto'},
  'presets': {
    'bookType': 'lead_magnet',
    'bookTypeChoice': 'auto',
    'lengthPreset': 'short',
    'qualityPreset': 'balanced',
    'imagesEnabled': true,
    'pageCountMode': 'auto',
  },
  'detectedLane': 'auto',
  'quickReplies': <String>[],
  'question': null,
  'readiness': {'score': 80, 'canBuild': true, 'missing': <dynamic>[]},
  'titleSuggestions': <dynamic>[],
  'shapePreview': ['Intro'],
  'warnings': <String>[],
  'buildRequested': false,
};

class StubGenerationBillingRepository implements BillingRepository {
  StubGenerationBillingRepository({this.failing = false});

  bool failing;
  int calls = 0;

  @override
  Future<MobileBilling> getBilling() async {
    calls += 1;
    if (failing) {
      throw const ApiException(
        code: 'NETWORK_ERROR',
        message: 'Check your connection and try again.',
      );
    }
    return const MobileBilling(
      credits: CreditBalance(
        available: 100,
        reserved: 0,
        lifetimeGranted: 100,
        lifetimeSpent: 0,
      ),
      entitlements: [],
      products: [],
      creditCosts: {},
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Billing is not used in this test.');
  }
}
