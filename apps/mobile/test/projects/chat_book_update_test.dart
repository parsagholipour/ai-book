import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_chat_progress.dart';
import 'package:tomeza/features/projects/presentation/project_chat_screen.dart';

/// A free change's reply ends with the book it rebuilt: "Updating your book…"
/// while the new PDF is made, then Open book (Parsa, 2026-10-17, after a matter
/// edit's "Done" left nothing in the chat to say the book was ready).
void main() {
  group('which reply carries the book', () {
    test('the last reply, when it rebuilt the book', () {
      final done = _message('m1', 'assistant', 'Done', revision: 2);
      expect(
        chatBookUpdateMessage([_message('m0', 'user', 'Use my profile'), done]),
        same(done),
      );
      // The reader's next message does not take it off: the reply is still the last one.
      expect(
        chatBookUpdateMessage([done, _message('m2', 'user', 'thanks')]),
        same(done),
      );
    });

    test(
      'nothing once a later reply has spoken, or for a reply that rebuilt nothing',
      () {
        final done = _message('m1', 'assistant', 'Done', revision: 2);
        expect(
          chatBookUpdateMessage([
            done,
            _message('m2', 'assistant', 'Page 3 is about…'),
          ]),
          isNull,
        );
        expect(
          chatBookUpdateMessage([_message('m1', 'assistant', 'Which field?')]),
          isNull,
        );
        expect(chatBookUpdateMessage(const []), isNull);
      },
    );
  });

  group('updating or ready', () {
    test('updating while the rebuild runs, or before any status', () {
      expect(
        chatBookUpdateState(revision: 2, status: null),
        ChatBookUpdateState.updating,
      );
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('editing', revision: 2),
        ),
        ChatBookUpdateState.updating,
      );
    });

    test('never ready on a status from before the change', () {
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('complete', revision: 1),
        ),
        ChatBookUpdateState.updating,
      );
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('complete', revision: 2, pdf: false),
        ),
        ChatBookUpdateState.updating,
      );
    });

    test('ready once the book is settled at that revision or later', () {
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('complete', revision: 2),
        ),
        ChatBookUpdateState.ready,
      );
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('review_required', revision: 3),
        ),
        ChatBookUpdateState.ready,
      );
    });

    test('no row for a book in neither state', () {
      expect(
        chatBookUpdateState(
          revision: 2,
          status: _status('failed', revision: 2),
        ),
        isNull,
      );
    });
  });

  testWidgets('the reply shows the rebuild, then opens the new book', (
    tester,
  ) async {
    final repository = _Repository();
    await tester.pumpWidget(_app(repository));
    await tester.pump();

    repository.status.add(_status('editing', revision: 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const ValueKey('chat-book-updating')), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-book-open')), findsNothing);
    // The reply stands in for the live progress card while it does.
    expect(find.byType(ChatOperationProgressCard), findsNothing);

    repository.status.add(_status('complete', revision: 2));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const ValueKey('chat-book-updating')), findsNothing);
    expect(find.text('Your book is ready with this change.'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('chat-book-open')));
    await tester.pumpAndSettle();
    expect(find.text('Reader for project-1'), findsOneWidget);
  });
}

MobileProjectChatMessage _message(
  String id,
  String role,
  String content, {
  int? revision,
}) {
  return MobileProjectChatMessage(
    id: id,
    projectId: 'project-1',
    parentId: null,
    role: role,
    content: content,
    metadata: {
      if (revision != null) 'bookUpdate': {'contentRevision': revision},
    },
    createdAt: DateTime.utc(2026, 10, 17),
  );
}

MobileProjectStatus _status(
  String status, {
  required int revision,
  bool pdf = true,
}) {
  Map<String, Object?> export(String format, bool available) => {
    'format': format,
    'available': available,
    'unlocked': true,
    'creditsRequired': 0,
    'downloadUrl': '/export/$format',
    'filename': 'book.$format',
    'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
    'revision': revision,
  };
  return MobileProjectStatus.fromJson({
    'projectId': 'project-1',
    'status': status,
    'statusLabel': status,
    'progressPercent': status == 'editing' ? 40 : 100,
    'currentAction': status == 'editing' ? 'Preparing your PDF' : 'Ready',
    'retryAvailable': false,
    'steps': <Object?>[],
    'pageProgress': {'completed': 10, 'target': 10},
    'imageCount': 0,
    'exports': {'pdf': export('pdf', pdf), 'epub': export('epub', true)},
    'updatedAt': '2026-10-17T17:34:34.000Z',
  });
}

Widget _app(_Repository repository) {
  final router = GoRouter(
    initialLocation: '/projects/project-1/chat',
    routes: [
      GoRoute(
        path: '/projects/:id/chat',
        builder: (context, state) =>
            ProjectChatScreen(projectId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/projects/:id/read',
        builder: (context, state) =>
            Material(child: Text('Reader for ${state.pathParameters['id']}')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp.router(routerConfig: router),
  );
}

/// The chat of "The Last Table" after its author name was set from the profile.
class _Repository implements ProjectsRepository {
  final status = StreamController<MobileProjectStatus>.broadcast();

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return MobileProjectChat(
      messages: [
        _message('m0', 'user', 'Whatever I added in my profile'),
        _message(
          'm1',
          'assistant',
          'Done — the author name is now “Parsa Gholipour”. This one’s free.',
          revision: 2,
        ),
      ],
      operations: const [],
      openProposalId: null,
    );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) => status.stream;

  @override
  Future<MobileProjectDetail> getProject(String id) {
    return Future<MobileProjectDetail>.error(
      UnimplementedError('Project detail is not used in this test.'),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
