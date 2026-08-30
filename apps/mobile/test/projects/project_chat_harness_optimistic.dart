/// Shared fixtures for the project-chat suites: the scripted repository whose
/// send/edit calls resolve or fail on demand, the screen scaffold, and the
/// operation/progress fixtures. Split out of project_chat_optimistic_test.dart
/// when it outgrew the file budget.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

ScrollPosition scrollPosition(WidgetTester tester) {
  return tester
      .widget<Scrollable>(find.byType(Scrollable).first)
      .controller!
      .position;
}

Widget chatApp(
  ScriptedProjectsRepository repository, {
  String? initialMessage,
  Map<String, Object>? initialReaderContext,
}) {
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp(
      home: ProjectChatScreen(
        projectId: 'project-1',
        initialMessage: initialMessage,
        initialReaderContext: initialReaderContext,
      ),
    ),
  );
}

/// Fake linear-chat repository whose send/edit calls can be gated to resolve
/// or fail on demand.
class ScriptedProjectsRepository implements ProjectsRepository {
  final _contents = <({String role, String content})>[
    (role: 'assistant', content: 'Hi! What should we edit?'),
    (role: 'user', content: 'Existing user message'),
  ];
  final sendGates = <Completer<void>>[];
  final editGates = <Completer<void>>[];
  final sendRequestIds = <String?>[];
  final sentReaderContexts = <Map<String, Object>?>[];
  final sentMessages = <String>[];
  final chatFetches = <String>[];
  final statusController = StreamController<MobileProjectStatus>.broadcast();
  MobileProjectChatSendResult Function()? applyResult;
  MobileProjectChatSendResult Function()? undoResult;

  /// The operation a send comes back with, when the message queued real work.
  MobileBookEditOperation? sendOperation;

  /// Pushes a status the screen's live tracker will react to.
  void emitStatus({
    required String status,
    int progressPercent = 0,
    String action = '',
    MobileGenerationProgress? editProgress,
  }) {
    statusController.add(
      MobileProjectStatus(
        projectId: 'project-1',
        status: status,
        statusLabel: status,
        progressPercent: progressPercent,
        currentAction: action,
        editProgress: editProgress,
        retryAvailable: false,
        steps: const [],
        pageProgress: const MobilePageProgress(completed: 3, target: 12),
        imageCount: 0,
        exports: const MobileExportSet(
          pdf: MobileExportAvailability(
            format: 'pdf',
            available: false,
            unlocked: true,
            creditsRequired: 0,
            downloadUrl: '',
            filename: 'book.pdf',
            contentType: 'application/pdf',
          ),
          epub: MobileExportAvailability(
            format: 'epub',
            available: false,
            unlocked: true,
            creditsRequired: 0,
            downloadUrl: '',
            filename: 'book.epub',
            contentType: 'application/epub+zip',
          ),
        ),
        updatedAt: DateTime.utc(2026, 6, 15),
      ),
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) =>
      statusController.stream;
  final editRequestIds = <String?>[];

  final operations = <MobileBookEditOperation>[];

  /// An edit that was applied a turn ago, followed by a fresh request whose
  /// priced proposal is still waiting on Apply.
  void withAppliedEditThenPendingProposal({
    bool anchored = true,
    bool changesAvailable = true,
  }) {
    _contents
      ..add((role: 'user', content: 'Apply'))
      ..add((
        role: 'assistant',
        content: 'I’ll rewrite page 1 and refresh the exports.',
      ))
      ..add((role: 'user', content: 'On page 1, replace "night" with "day".'))
      ..add((
        role: 'assistant',
        content: 'Edit page 1. Tap Apply to confirm, or Cancel to drop it.',
      ));
    operations.add(
      MobileBookEditOperation(
        id: 'op-1',
        projectId: 'project-1',
        kind: 'page_rewrite',
        status: 'applied',
        affectedPageIndexes: const [1],
        creditsCharged: 80,
        currentAction: 'Edit applied.',
        createdAt: DateTime.utc(2026, 6, 15, 1),
        anchorMessageId: anchored ? 'm3' : null,
        canUndo: true,
        changesAvailable: changesAvailable,
      ),
    );
  }

  /// A book-replan that failed weeks ago, then a fresh page edit awaiting Apply.
  void withOldFailedReplan() {
    _contents
      ..add((role: 'user', content: 'Now regenerate it in Persian'))
      ..add((
        role: 'assistant',
        content:
            'I created a new Persian copy and I\u2019ll rebuild the plan '
            'and book there.',
      ))
      ..add((
        role: 'user',
        content: 'On page 2, replace "Bunny" with "cute Bunny".',
      ))
      ..add((
        role: 'assistant',
        content: 'Edit page 2. Tap Apply to confirm, or Cancel to drop it.',
      ));
    operations.add(
      MobileBookEditOperation(
        id: 'op-replan',
        projectId: 'project-1',
        kind: 'book_replan',
        status: 'failed',
        affectedPageIndexes: const [],
        creditsCharged: 705,
        currentAction: 'Edit failed.',
        createdAt: DateTime.utc(2026, 7, 5),
        anchorMessageId: 'm3',
        creditsRefunded: true,
      ),
    );
  }

  /// An earlier applied edit, superseded for undo by the newer one.
  void withSecondAppliedEdit() {
    operations.add(
      MobileBookEditOperation(
        id: 'op-0',
        projectId: 'project-1',
        kind: 'local_patch',
        status: 'applied',
        affectedPageIndexes: const [4],
        creditsCharged: 35,
        currentAction: 'Edit applied.',
        createdAt: DateTime.utc(2026, 6, 15),
        anchorMessageId: 'm1',
        changesAvailable: true,
      ),
    );
  }

  /// Enough history that the transcript scrolls.
  void fillWithManyMessages() {
    for (var index = 0; index < 40; index++) {
      _contents.add((role: 'assistant', content: 'Earlier message $index'));
    }
    _contents.add((role: 'user', content: 'The newest message'));
  }

  MobileProjectChat _chat() {
    return MobileProjectChat(
      messages: [
        for (final (index, entry) in _contents.indexed)
          MobileProjectChatMessage(
            id: 'm$index',
            projectId: 'project-1',
            parentId: index == 0 ? null : 'm${index - 1}',
            role: entry.role,
            content: entry.content,
            metadata: const {},
            createdAt: DateTime.utc(2026, 6, 15).add(Duration(minutes: index)),
          ),
      ],
      operations: List.of(operations),
    );
  }

  MobileProjectChatSendResult _appendTurn(String message) {
    _contents.add((role: 'user', content: message));
    _contents.add((role: 'assistant', content: 'Reply about $message'));
    final chat = _chat();
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: chat.messages.last,
      operation: sendOperation,
    );
  }

  MobileProjectChatSendResult successfulUndoResult() {
    _contents.add((role: 'user', content: 'Undo'));
    _contents.add((
      role: 'assistant',
      content:
          'I restored page 1 to how it was and I’m rebuilding your book now. '
          'Undo is free.',
    ));
    final chat = _chat();
    final reply = chat.messages.last;
    return MobileProjectChatSendResult(
      messages: chat.messages,
      operations: chat.operations,
      reply: MobileProjectChatMessage(
        id: reply.id,
        projectId: reply.projectId,
        parentId: reply.parentId,
        role: reply.role,
        content: reply.content,
        metadata: const {
          'undo': {
            'operationId': 'op-1',
            'restoredPageIndexes': [1],
          },
        },
        createdAt: reply.createdAt,
      ),
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    chatFetches.add(id);
    return _chat();
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
    String? replyToMessageId,
    List<String>? mentionedCharacterIds,
    Map<String, Object>? readerContext,
  }) async {
    sendRequestIds.add(requestId);
    sentMessages.add(message);
    sentReaderContexts.add(readerContext);
    if (sendGates.isNotEmpty) {
      await sendGates.removeAt(0).future;
    }
    return _appendTurn(message);
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
      List<String>? mentionedCharacterIds,
  }) async {
    editRequestIds.add(requestId);
    if (editGates.isNotEmpty) {
      await editGates.removeAt(0).future;
    }
    return _appendTurn(message);
  }

  @override
  Future<MobileProjectChatSendResult> applyEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    final build = applyResult;
    if (build == null) throw UnimplementedError();
    return build();
  }

  @override
  Future<MobileProjectChatSendResult> cancelEditProposal({
    required String projectId,
    required String proposalId,
    String? requestId,
  }) async {
    throw UnimplementedError();
  }

  @override
  Future<MobileProjectChatSendResult> undoLastBookEdit({
    required String projectId,
    String? requestId,
  }) async {
    final build = undoResult;
    if (build == null) throw UnimplementedError();
    return build();
  }

  @override
  Future<MobileProjectDetail> getProject(String id) {
    // Keeps the app bar on its 'Book chat' fallback title.
    return Future<MobileProjectDetail>.error(
      UnimplementedError('Project detail is not used in this test.'),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

/// The four milestones the server reports while an edit is being applied.
MobileGenerationProgress editProgress(
  int percent, {
  required String active,
  String? activeDetail,
}) {
  const labels = [
    'Reading your book',
    'Saving a version to undo',
    'Making your changes',
    'Rebuilding your book',
  ];
  final activeIndex = labels.indexOf(active);
  return MobileGenerationProgress(
    percent: percent,
    steps: [
      for (final (index, label) in labels.indexed)
        MobileProjectStatusStep(
          key: 'step-$index',
          label: label,
          status: index < activeIndex
              ? 'done'
              : index == activeIndex
              ? 'active'
              : 'pending',
          detail: index == activeIndex ? activeDetail : null,
        ),
    ],
  );
}

/// What a send comes back with once the message has queued real work.
MobileBookEditOperation queuedOperation() {
  return MobileBookEditOperation(
    id: 'op-queued',
    projectId: 'project-1',
    kind: 'page_rewrite',
    status: 'queued',
    affectedPageIndexes: const [3],
    creditsCharged: 80,
    currentAction: 'Rewriting selected pages.',
    createdAt: DateTime.utc(2026, 6, 15, 2),
    canUndo: false,
    changesAvailable: false,
  );
}
