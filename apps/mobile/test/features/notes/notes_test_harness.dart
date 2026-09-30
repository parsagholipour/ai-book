import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/notes/data/book_notes_repository.dart';
import 'package:tomeza/features/notes/presentation/book_note_editor_screen.dart';
import 'package:tomeza/features/notes/presentation/book_notes_screen.dart';
import 'package:tomeza/features/notes/presentation/notes_location.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/shared/api/api_client.dart';

import '../../projects/book_page_fixtures.dart';
import 'fake_book_notes_repository.dart';

const notesProjectId = 'project-1';

final notesTestConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://localhost:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/delete'),
  supportEmail: 'support@example.com',
);

/// The notes routes over a home page they can be popped back to.
class NotesTestApp {
  NotesTestApp({
    required this.repo,
    this.withBookTitle = false,
    this.brightness = Brightness.light,
    this.textScale = 1,
    this.textDirection = TextDirection.ltr,
    this.overrides = const [],
  }) {
    router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (context, state) => const _Home()),
        GoRoute(
          path: '/projects/:id/notes',
          builder: (context, state) =>
              BookNotesScreen(projectId: state.pathParameters['id']!),
        ),
        GoRoute(
          path: '/projects/:id/notes/:noteId',
          builder: (context, state) {
            final noteId = state.pathParameters['noteId']!;
            return BookNoteEditorScreen(
              projectId: state.pathParameters['id']!,
              noteId: noteId == newBookNoteId ? null : noteId,
            );
          },
        ),
        GoRoute(
          path: '/projects/:id',
          builder: (context, state) => const Scaffold(body: Text('book page')),
        ),
      ],
    );
  }

  final FakeBookNotesRepository repo;

  /// Keeps the book's detail loaded beneath, as the book page does, so the
  /// notes can show its title.
  final bool withBookTitle;
  final Brightness brightness;
  final double textScale;
  final TextDirection textDirection;
  final List<Override> overrides;
  late final GoRouter router;

  Widget build() {
    return ProviderScope(
      overrides: [
        bookNotesRepositoryProvider.overrideWithValue(repo),
        appConfigProvider.overrideWithValue(notesTestConfig),
        apiAuthHeadersProvider.overrideWith(
          (ref) async => const <String, String>{},
        ),
        projectDetailProvider.overrideWith((ref, id) async => bookProject()),
        ...overrides,
      ],
      child: _BookTitleKeeper(
        enabled: withBookTitle,
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: buildTomezaLightTheme(),
          darkTheme: buildTomezaDarkTheme(),
          themeMode: brightness == Brightness.dark
              ? ThemeMode.dark
              : ThemeMode.light,
          routerConfig: router,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: Directionality(textDirection: textDirection, child: child!),
          ),
        ),
      ),
    );
  }

  /// Pumps the app and opens [location] over the home page.
  Future<void> open(WidgetTester tester, String location) async {
    await tester.pumpWidget(build());
    await tester.pump();
    router.push(location);
    await settle(tester);
  }
}

class _Home extends StatelessWidget {
  const _Home();

  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: Text('home')));
}

/// Watches the book's detail, the way the book page beneath the notes does.
class _BookTitleKeeper extends ConsumerWidget {
  const _BookTitleKeeper({required this.enabled, required this.child});

  final bool enabled;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (enabled) ref.watch(projectDetailProvider(notesProjectId));
    return child;
  }
}

/// Pumps frames for [duration] in 100 ms steps: enough for debounced saves,
/// snack bars and page transitions, without `pumpAndSettle` (a focused
/// field's cursor never settles).
Future<void> settle(
  WidgetTester tester, [
  Duration duration = const Duration(milliseconds: 800),
]) async {
  final steps = duration.inMilliseconds ~/ 100;
  for (var i = 0; i < steps; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Lets a debounced save fire and land.
Future<void> letSave(WidgetTester tester) =>
    settle(tester, const Duration(milliseconds: 1200));
