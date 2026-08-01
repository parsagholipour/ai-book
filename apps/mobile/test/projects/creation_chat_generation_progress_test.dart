import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/shared/ui/motion.dart';

/// The live writing progress the chat shows after a plan is approved. Planning
/// already reports itself this way; these pin that a book does too.
void main() {
  testWidgets('generating shows the milestone list with a spinner on the '
      'active step', (tester) async {
    await _pumpChat(
      tester,
      status: _status(
        generationProgress: const MobileGenerationProgress(
          percent: 46,
          detail: 'Writing page 18 of 40',
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Preparing your chapters',
              status: 'done',
              detail: '6 chapters',
            ),
            MobileProjectStatusStep(
              key: 'write',
              label: 'Writing your pages',
              status: 'active',
              detail: '17 of 40 pages',
            ),
            MobileProjectStatusStep(
              key: 'illustrate',
              label: 'Creating your illustrations',
              status: 'pending',
            ),
            MobileProjectStatusStep(
              key: 'finish',
              label: 'Building your book',
              status: 'pending',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing page 18 of 40'), findsOneWidget);
    expect(find.text('46%'), findsOneWidget);
    expect(find.text('Preparing your chapters'), findsOneWidget);
    expect(find.text('Writing your pages'), findsOneWidget);
    expect(find.text('Creating your illustrations'), findsOneWidget);
    expect(find.text('Building your book'), findsOneWidget);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsOneWidget,
    );

    final activeRow = find.bySemanticsLabel('Writing your pages. In progress.');
    expect(activeRow, findsOneWidget);
    expect(
      find.descendant(
        of: activeRow,
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel('Preparing your chapters. Done.'),
      findsOneWidget,
    );
  });

  testWidgets('a text-only book never shows an illustration step', (
    tester,
  ) async {
    await _pumpChat(
      tester,
      status: _status(
        generationProgress: const MobileGenerationProgress(
          percent: 52,
          detail: 'Writing page 9 of 20',
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Preparing your chapters',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'write',
              label: 'Writing your pages',
              status: 'active',
            ),
            MobileProjectStatusStep(
              key: 'finish',
              label: 'Building your book',
              status: 'pending',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Writing your pages'), findsOneWidget);
    expect(find.text('Creating your illustrations'), findsNothing);
  });

  testWidgets('the bar never animates backwards on a stale tick', (
    tester,
  ) async {
    final controller = StreamController<MobileProjectStatus>();
    addTearDown(controller.close);
    await _pumpChat(tester, statusStream: controller.stream);

    controller.add(_status(progressPercent: 62));
    await _settleEnough(tester);
    expect(find.text('62%'), findsOneWidget);

    controller.add(_status(progressPercent: 55));
    await _settleEnough(tester);
    expect(find.text('62%'), findsOneWidget);
    expect(find.text('55%'), findsNothing);
  });

  testWidgets('the first tick is a skeleton of the real card, not a bare '
      'spinner', (tester) async {
    final controller = StreamController<MobileProjectStatus>();
    addTearDown(controller.close);
    await _pumpChat(tester, statusStream: controller.stream);

    expect(find.byType(AppShimmer), findsOneWidget);
    expect(find.bySemanticsLabel('Checking writing progress…'), findsOneWidget);

    controller.add(_status());
    await _settleEnough(tester);

    expect(find.byType(AppShimmer), findsNothing);
  });

  testWidgets('the leave-this-chat reassurance goes away once the book is '
      'finished', (tester) async {
    await _pumpChat(
      tester,
      status: _status(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
        currentAction: 'Ready to download.',
      ),
    );

    expect(find.text('Ready to export'), findsOneWidget);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsNothing,
    );
  });

  testWidgets('an API build without generationProgress still renders the '
      'compact bubble', (tester) async {
    await _pumpChat(tester, status: _status());

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing your book pages.'), findsOneWidget);
    expect(find.text('3/28 pages'), findsOneWidget);
    expect(find.text('1 visual'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);
    // The client-side placeholder shapes the list; it never narrates.
    expect(find.text('Preparing your chapters'), findsOneWidget);
  });

  testWidgets('View progress still opens the handoff screen', (tester) async {
    await _pumpChat(tester, status: _status());

    await tester.tap(find.text('View progress'));
    await _settleEnough(tester);

    expect(find.text('Progress route project-1'), findsOneWidget);
  });
}

/// Pumps far enough for the crossfades and the eased bar, but never waits for
/// the step spinner — that animation is continuous by design.
Future<void> _settleEnough(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> _pumpChat(
  WidgetTester tester, {
  MobileProjectStatus? status,
  Stream<MobileProjectStatus>? statusStream,
}) async {
  final projects = _StubProjectsRepository(
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
        path: '/projects/:id/handoff',
        builder: (context, state) => Scaffold(
          body: Text('Progress route ${state.pathParameters['id']}'),
        ),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(
          _StubCreationRepository(),
        ),
        projectsRepositoryProvider.overrideWithValue(projects),
        billingRepositoryProvider.overrideWithValue(_StubBillingRepository()),
      ],
      child: MaterialApp.router(
        theme: buildTomezaLightTheme(),
        routerConfig: router,
      ),
    ),
  );
  await _settleEnough(tester);
}

MobileProjectStatus _status({
  String status = 'generating',
  String? statusLabel,
  int progressPercent = 38,
  String currentAction = 'Writing your book pages.',
  MobileGenerationProgress? generationProgress,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: statusLabel ?? 'Generating your book',
    progressPercent: progressPercent,
    currentAction: currentAction,
    generationProgress: generationProgress,
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 3, target: 28),
    imageCount: 1,
    exports: _exports,
    updatedAt: DateTime.utc(2026, 6, 15),
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

class _StubProjectsRepository implements ProjectsRepository {
  _StubProjectsRepository({this.status, this.statusStream});

  final MobileProjectStatus? status;
  final Stream<MobileProjectStatus>? statusStream;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) {
    final stream = statusStream;
    if (stream != null) {
      return stream;
    }
    return Stream.value(status ?? _status());
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return status ?? _status();
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
      exports: _exports,
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

class _StubCreationRepository implements CreationRepository {
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

class _StubBillingRepository implements BillingRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Billing is not used in this test.');
  }
}
