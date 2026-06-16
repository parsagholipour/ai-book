import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/shared/ui/app_components.dart';
import 'package:tomeza/shared/ui/feedback/app_feedback.dart';

void main() {
  testWidgets('feedback states expose loading, empty, and error actions', (
    tester,
  ) async {
    var emptyActionTapped = false;
    var retryTapped = false;
    final semanticsHandle = tester.ensureSemantics();

    await tester.pumpWidget(
      componentTestApp(
        child: ListView(
          children: [
            const AppLoadingState(message: 'Loading projects'),
            AppEmptyState(
              title: 'No books yet',
              message: 'Start your first book from here.',
              actionLabel: 'Start book',
              onAction: () => emptyActionTapped = true,
            ),
            AppErrorState(
              title: 'Projects unavailable',
              message: 'Check your connection and try again.',
              onRetry: () => retryTapped = true,
            ),
          ],
        ),
      ),
    );

    expect(find.text('Loading projects'), findsOneWidget);
    expect(find.text('No books yet'), findsOneWidget);
    expect(find.text('Projects unavailable'), findsOneWidget);
    expect(
      tester.getSemantics(find.byType(AppLoadingState)).label,
      contains('Loading projects'),
    );
    semanticsHandle.dispose();

    await tester.tap(find.widgetWithText(FilledButton, 'Start book'));
    await tester.tap(find.widgetWithText(OutlinedButton, 'Try again'));
    await tester.pump();

    expect(emptyActionTapped, isTrue);
    expect(retryTapped, isTrue);
  });

  testWidgets('choice tile reports selection and handles taps', (tester) async {
    var selected = 'lead';

    await tester.pumpWidget(
      componentTestApp(
        child: StatefulBuilder(
          builder: (context, setState) => Column(
            children: [
              AppChoiceTile(
                selected: selected == 'lead',
                icon: Icons.campaign_outlined,
                title: 'Lead magnet ebook',
                subtitle: 'A focused guide for subscribers.',
                onTap: () => setState(() => selected = 'lead'),
              ),
              AppChoiceTile(
                selected: selected == 'workbook',
                icon: Icons.assignment_outlined,
                title: 'Workbook',
                subtitle: 'Lessons and exercises.',
                onTap: () => setState(() => selected = 'workbook'),
              ),
            ],
          ),
        ),
      ),
    );

    expect(selected, 'lead');
    await tester.tap(find.text('Workbook'));
    await tester.pump();

    expect(selected, 'workbook');
    expect(tester.takeException(), isNull);
  });

  testWidgets('badges chips notices and action panels render at large text', (
    tester,
  ) async {
    var noticeTapped = false;
    var actionTapped = false;

    for (final scenario in const [
      _ComponentScenario(themeMode: ThemeMode.light),
      _ComponentScenario(themeMode: ThemeMode.dark),
      _ComponentScenario(textScale: 1.7),
    ]) {
      await tester.pumpWidget(
        componentTestApp(
          themeMode: scenario.themeMode,
          textScale: scenario.textScale,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const AppSectionHeader(
                title: 'Pick up next',
                subtitle: 'Start with the first book below.',
                icon: Icons.menu_book_outlined,
              ),
              const SizedBox(height: 12),
              const Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppStatusBadge(
                    label: 'Needs attention',
                    tone: AppNoticeTone.error,
                  ),
                  AppMetricChip(
                    label: 'Length',
                    value: 'Expanded workbook',
                    icon: Icons.notes_outlined,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              AppInlineNotice(
                title: 'Credit balance unavailable',
                message: 'Try again before starting a paid book action.',
                actionLabel: 'Retry',
                onAction: () => noticeTapped = true,
              ),
              const SizedBox(height: 12),
              AppPrimaryActionPanel(
                title: 'Ready for a plan',
                message: 'Create a reviewable outline before writing starts.',
                actionLabel: 'Create book plan',
                onAction: () => actionTapped = true,
              ),
            ],
          ),
        ),
      );

      expect(find.text('Pick up next'), findsOneWidget);
      expect(find.text('Needs attention'), findsOneWidget);
      expect(find.text('Length: Expanded workbook'), findsOneWidget);
      expect(find.text('Credit balance unavailable'), findsOneWidget);
      expect(find.text('Ready for a plan'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox.shrink());
    }

    await tester.pumpWidget(
      componentTestApp(
        child: Column(
          children: [
            AppInlineNotice(
              title: 'Credit balance unavailable',
              message: 'Try again before starting a paid book action.',
              actionLabel: 'Retry',
              onAction: () => noticeTapped = true,
            ),
            AppPrimaryActionPanel(
              title: 'Ready for a plan',
              message: 'Create a reviewable outline before writing starts.',
              actionLabel: 'Create book plan',
              onAction: () => actionTapped = true,
            ),
          ],
        ),
      ),
    );

    await tester.tap(find.widgetWithText(TextButton, 'Retry'));
    await tester.tap(find.widgetWithText(FilledButton, 'Create book plan'));
    await tester.pump();

    expect(noticeTapped, isTrue);
    expect(actionTapped, isTrue);
  });

  testWidgets('confirmation dialog returns the selected action', (
    tester,
  ) async {
    bool? confirmed;

    await tester.pumpWidget(
      componentTestApp(
        child: Builder(
          builder: (context) => FilledButton(
            onPressed: () async {
              confirmed = await showAppConfirmationDialog(
                context,
                title: 'Delete this project?',
                message: 'This removes generated files from your account.',
                confirmLabel: 'Delete project',
                destructive: true,
              );
            },
            child: const Text('Open dialog'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open dialog'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete project'));
    await tester.pumpAndSettle();

    expect(confirmed, isTrue);
  });
}

Widget componentTestApp({
  required Widget child,
  ThemeMode themeMode = ThemeMode.light,
  double textScale = 1,
}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    darkTheme: buildTomezaDarkTheme(),
    themeMode: themeMode,
    builder: (context, appChild) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(textScale)),
      child: appChild ?? const SizedBox.shrink(),
    ),
    home: Scaffold(body: SafeArea(child: child)),
  );
}

class _ComponentScenario {
  const _ComponentScenario({
    this.themeMode = ThemeMode.light,
    this.textScale = 1,
  });

  final ThemeMode themeMode;
  final double textScale;
}
