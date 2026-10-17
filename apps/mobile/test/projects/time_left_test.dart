import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/generation_duration.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_overview.dart';
import 'package:tomeza/features/projects/presentation/project_chat_progress.dart';
import 'package:tomeza/features/projects/presentation/time_left_note.dart';

// "About 4 min left" while a plan or a book is being made. The seconds are the
// server's (`estimatedSecondsLeft` on the planning and generation progress);
// the words are the app's, and so is the count down between two statuses.

Map<String, dynamic> _statusJson({
  String status = 'generating',
  Object? planningProgress,
  Object? generationProgress,
  String? failureMessage,
}) {
  return {
    'projectId': 'project-1',
    'status': status,
    'statusLabel': 'Generating your book',
    'progressPercent': 40,
    'currentAction': 'Writing chapter 2 of 6',
    'retryAvailable': false,
    'steps': <Object?>[],
    'pageProgress': {'completed': 0, 'target': 24},
    'imageCount': 0,
    'exports': {'pdf': _export('pdf'), 'epub': _export('epub')},
    'quality': <String, Object?>{},
    'updatedAt': '2026-10-17T10:00:00.000Z',
    'planningProgress': ?planningProgress,
    'generationProgress': ?generationProgress,
    'failureMessage': ?failureMessage,
  };
}

Map<String, dynamic> _export(String format) => {
  'format': format,
  'available': false,
  'unlocked': true,
  'creditsRequired': 0,
  'downloadUrl': '/export/$format',
  'filename': 'book.$format',
  'contentType': format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  'revision': 1,
  'byteSize': 0,
  'updatedAt': '2026-10-17T10:00:00.000Z',
};

Map<String, dynamic> _progress(Object? secondsLeft, {int percent = 40}) => {
  'percent': percent,
  'estimatedSecondsLeft': ?secondsLeft,
  'steps': <Object?>[],
};

MobileProjectStatus _status({
  String status = 'generating',
  Object? planningProgress,
  Object? generationProgress,
  String? failureMessage,
}) => MobileProjectStatus.fromJson(
  _statusJson(
    status: status,
    planningProgress: planningProgress,
    generationProgress: generationProgress,
    failureMessage: failureMessage,
  ),
);

Widget _host(Widget child) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

/// Past the line's rise-into-place, so only the current words are on screen.
Future<void> _settleLine(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

void main() {
  group('the words', () {
    test('round up to whole minutes, and say it plainly under one', () {
      expect(formatTimeLeft(270), 'About 5 min left');
      expect(formatTimeLeft(61), 'About 2 min left');
      expect(formatTimeLeft(60), 'About 1 min left');
      expect(formatTimeLeft(59), 'Less than a minute left');
      expect(formatTimeLeft(1), 'Less than a minute left');
      expect(formatTimeLeft(0), 'Almost done');
      expect(formatTimeLeft(-20), 'Almost done');
    });

    test('read the seconds the server sends on both progress objects', () {
      final status = _status(
        status: 'planning',
        planningProgress: _progress(240),
        generationProgress: _progress(1200),
      );
      expect(status.planningProgress?.estimatedSecondsLeft, 240);
      expect(status.generationProgress?.estimatedSecondsLeft, 1200);
      // An older server sends nothing, a server without a number sends null,
      // and nothing that is not a count of seconds is believed.
      expect(
        _status(
          generationProgress: _progress(null),
        ).generationProgress?.estimatedSecondsLeft,
        isNull,
      );
      expect(
        _status(
          generationProgress: _progress('soon'),
        ).generationProgress?.estimatedSecondsLeft,
        isNull,
      );
      expect(
        _status(
          generationProgress: _progress(-30),
        ).generationProgress?.estimatedSecondsLeft,
        isNull,
      );
      expect(
        _status(
          generationProgress: _progress(90.4),
        ).generationProgress?.estimatedSecondsLeft,
        90,
      );
    });
  });

  group('the count down', () {
    testWidgets('steps down between statuses and lands on "Almost done"', (
      tester,
    ) async {
      await tester.pumpWidget(_host(const TimeLeftNote(secondsLeft: 90)));
      await _settleLine(tester);
      expect(find.text('About 2 min left'), findsOneWidget);

      await tester.pump(const Duration(seconds: 40));
      await _settleLine(tester);
      expect(find.text('Less than a minute left'), findsOneWidget);

      await tester.pump(const Duration(seconds: 50));
      await _settleLine(tester);
      expect(find.text('Almost done'), findsOneWidget);
      expect(find.byIcon(Icons.schedule_outlined), findsOneWidget);
    });

    testWidgets('never winds back up on a resent estimate, only on a new one', (
      tester,
    ) async {
      await tester.pumpWidget(_host(const TimeLeftNote(secondsLeft: 90)));
      await tester.pump(const Duration(seconds: 90));
      await _settleLine(tester);
      expect(find.text('Almost done'), findsOneWidget);

      // Another status with the same estimate: the count keeps its place.
      await tester.pumpWidget(_host(const TimeLeftNote(secondsLeft: 90)));
      await _settleLine(tester);
      expect(find.text('Almost done'), findsOneWidget);

      // A new estimate from the server is the only thing that raises it.
      await tester.pumpWidget(_host(const TimeLeftNote(secondsLeft: 300)));
      await _settleLine(tester);
      expect(find.text('About 5 min left'), findsOneWidget);
    });

    testWidgets('draws nothing without an estimate', (tester) async {
      await tester.pumpWidget(_host(const TimeLeftNote(secondsLeft: null)));
      expect(find.byIcon(Icons.schedule_outlined), findsNothing);
      expect(find.textContaining('left'), findsNothing);
    });
  });

  group('the book page', () {
    testWidgets('says how long the plan has left while it is planned', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          GenerationProgressOverviewCard(
            status: _status(
              status: 'planning',
              planningProgress: _progress(240),
            ),
            busyAction: null,
          ),
        ),
      );
      await _settleLine(tester);
      expect(find.text('About 4 min left'), findsOneWidget);
    });

    testWidgets('says how long the book has left, and counts it down', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          GenerationProgressOverviewCard(
            status: _status(generationProgress: _progress(50)),
            busyAction: null,
          ),
        ),
      );
      await _settleLine(tester);
      expect(find.text('Less than a minute left'), findsOneWidget);

      await tester.pump(const Duration(seconds: 50));
      await _settleLine(tester);
      expect(find.text('Almost done'), findsOneWidget);
    });

    testWidgets('says nothing without an estimate, or once the book stopped', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          GenerationProgressOverviewCard(
            status: _status(generationProgress: _progress(null)),
            busyAction: null,
          ),
        ),
      );
      expect(find.byIcon(Icons.schedule_outlined), findsNothing);

      await tester.pumpWidget(
        _host(
          GenerationProgressOverviewCard(
            status: _status(
              generationProgress: _progress(600),
              failureMessage: 'We hit a problem while writing a page.',
            ),
            busyAction: null,
          ),
        ),
      );
      expect(find.byIcon(Icons.schedule_outlined), findsNothing);
      expect(find.textContaining('min left'), findsNothing);
    });
  });

  group('the book chat', () {
    testWidgets(
      'says how long a plan revision has left, and nothing for an edit',
      (tester) async {
        await tester.pumpWidget(
          _host(
            ChatOperationProgressCard(
              status: _status(
                status: 'planning',
                planningProgress: _progress(120),
              ),
            ),
          ),
        );
        await _settleLine(tester);
        expect(find.text('About 2 min left'), findsOneWidget);

        await tester.pumpWidget(
          _host(
            ChatOperationProgressCard(
              status: _status(
                status: 'editing',
                generationProgress: _progress(120),
              ),
            ),
          ),
        );
        await _settleLine(tester);
        expect(find.textContaining('min left'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  });
}
