import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_overview.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

// A book waiting its turn behind other readers' books says so under its
// progress, from the count the server sends; and the server's refusal to start
// one more book than an account may hold reaches the reader as its own
// sentence, through the same path every book-starting screen already shows.

Map<String, dynamic> _statusJson({Object? waitingInLine}) {
  return {
    'projectId': 'project-1',
    'status': 'generating',
    'statusLabel': 'Writing',
    'progressPercent': 0,
    'currentAction': 'Getting your book ready',
    'retryAvailable': false,
    'steps': <Object?>[],
    'pageProgress': {'completed': 0, 'target': 24},
    'imageCount': 0,
    'exports': {'pdf': _export('pdf'), 'epub': _export('epub')},
    'quality': <String, Object?>{},
    'updatedAt': '2026-10-13T10:00:00.000Z',
    'waitingInLine': ?waitingInLine,
  };
}

Map<String, dynamic> _export(String format) => {
  'format': format,
  'available': false,
  'unlocked': false,
  'creditsRequired': 150,
  'downloadUrl': '/export/$format',
  'filename': 'book.$format',
  'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  'revision': 1,
  'byteSize': 0,
  'updatedAt': '2026-10-13T10:00:00.000Z',
};

Widget _host(Widget child, {bool reducedMotion = false}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reducedMotion),
      child: Scaffold(body: SingleChildScrollView(child: child)),
    ),
  );
}

void main() {
  group('waiting in line', () {
    test('reads the count the server sends and says it calmly', () {
      String? label(Object? waiting) =>
          MobileProjectStatus.fromJson(
            _statusJson(waitingInLine: waiting),
          ).waitingInLineLabel;

      expect(
        label({'booksAhead': 2}),
        'Waiting in line — 2 books ahead of yours',
      );
      expect(label({'booksAhead': 1}), 'Waiting in line — 1 book ahead of yours');
      expect(label({'booksAhead': 0}), 'Starting soon');
      // An older server sends nothing; a book being written is not waiting.
      expect(label(null), isNull);
    });

    testWidgets('draws the line under the book progress, and turns while it waits', (
      tester,
    ) async {
      final status = MobileProjectStatus.fromJson(
        _statusJson(waitingInLine: {'booksAhead': 2}),
      );
      await tester.pumpWidget(
        _host(GenerationProgressOverviewCard(status: status, busyAction: null)),
      );
      expect(
        find.text('Waiting in line — 2 books ahead of yours'),
        findsOneWidget,
      );

      final hourglass = find.byIcon(Icons.hourglass_bottom_rounded);
      expect(hourglass, findsOneWidget);
      RotationTransition turning() => tester.widget<RotationTransition>(
        find.ancestor(of: hourglass, matching: find.byType(RotationTransition)),
      );
      // Rests, then turns over: a processing state is never a still screen.
      await tester.pump(const Duration(milliseconds: 2900));
      expect(turning().turns.value, greaterThan(0));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('says "Starting soon" when it is next, and holds still under reduced motion', (
      tester,
    ) async {
      final status = MobileProjectStatus.fromJson(
        _statusJson(waitingInLine: {'booksAhead': 0}),
      );
      await tester.pumpWidget(
        _host(
          GenerationProgressOverviewCard(status: status, busyAction: null),
          reducedMotion: true,
        ),
      );
      expect(find.text('Starting soon'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      final turning = tester.widget<RotationTransition>(
        find.ancestor(
          of: find.byIcon(Icons.hourglass_bottom_rounded),
          matching: find.byType(RotationTransition),
        ),
      );
      expect(turning.turns.value, 0);
    });

    testWidgets('draws nothing for a book that is not waiting', (tester) async {
      final status = MobileProjectStatus.fromJson(_statusJson());
      await tester.pumpWidget(
        _host(GenerationProgressOverviewCard(status: status, busyAction: null)),
      );
      expect(find.byIcon(Icons.hourglass_bottom_rounded), findsNothing);
      expect(find.textContaining('Waiting in line'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  test(
    'the books-in-progress refusal reaches the reader as the server sentence, and keeps the session',
    () async {
      const sentence =
          "You already have a book being made. You can start this one as soon as it's finished — free accounts make one book at a time.";
      final store = MemoryAuthTokenStore(_tokens());
      final api = ApiClient(
        dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
          ..httpClientAdapter = _RefusingAdapter(
            '{"error":{"code":"BOOKS_IN_PROGRESS_LIMIT","message":"$sentence","booksInProgress":{"limit":1,"inProgress":1}}}',
          ),
        tokenStore: store,
      );

      Object? caught;
      try {
        await api.postMap('/api/mobile/plans/plan-1/approve', data: {});
      } catch (error) {
        caught = error;
      }

      expect(caught, isA<ApiException>());
      final error = caught! as ApiException;
      expect(error.code, 'BOOKS_IN_PROGRESS_LIMIT');
      expect(error.statusCode, 429);
      expect(error.isAuthFailure, isFalse);
      expect(error.details['booksInProgress'], {'limit': 1, 'inProgress': 1});
      // Every screen that starts a book snackbars exactly this.
      expect(userFacingError(error), sentence);
      expect(await store.read(), isNotNull);
    },
  );
}

MobileSessionTokens _tokens() {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: 'access-token',
    accessTokenExpiresAt: now.add(const Duration(minutes: 5)),
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: now.add(const Duration(days: 1)),
  );
}

class _RefusingAdapter implements HttpClientAdapter {
  _RefusingAdapter(this.body);

  final String body;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    return ResponseBody.fromString(
      body,
      429,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}
