import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/shared/ui/app_components.dart';
import 'package:tomeza/shared/ui/feedback/app_feedback.dart';

void main() {
  testWidgets('app buttons standardize variants, state, semantics, and size', (
    tester,
  ) async {
    var taps = 0;
    final semanticsHandle = tester.ensureSemantics();

    await tester.pumpWidget(
      componentTestApp(
        child: ListView(
          children: [
            AppButton.primary(
              key: const ValueKey('primary-action'),
              label: 'Create plan',
              onPressed: () => taps += 1,
              leading: const Icon(Icons.add),
            ),
            AppButton.tonal(
              key: const ValueKey('tonal-action'),
              label: 'Try again',
              onPressed: () {},
            ),
            AppButton.outlined(
              key: const ValueKey('outlined-action'),
              label: 'Edit',
              onPressed: () {},
            ),
            AppButton.text(
              key: const ValueKey('text-action'),
              label: 'Cancel',
              onPressed: () {},
            ),
            AppButton.destructive(
              key: const ValueKey('destructive-action'),
              label: 'Delete',
              onPressed: () {},
            ),
            AppButton.primary(
              key: const ValueKey('loading-action'),
              label: 'Build',
              loadingLabel: 'Building the plan',
              loading: true,
              onPressed: () => taps += 100,
            ),
            const AppButton.primary(
              key: ValueKey('disabled-action'),
              label: 'Unavailable',
              onPressed: null,
            ),
          ],
        ),
      ),
    );

    for (final key in const [
      'primary-action',
      'tonal-action',
      'outlined-action',
      'text-action',
      'destructive-action',
      'loading-action',
      'disabled-action',
    ]) {
      expect(find.byKey(ValueKey(key)), findsOneWidget);
      expect(
        tester.getSize(find.byKey(ValueKey(key))).height,
        greaterThanOrEqualTo(AppSizes.minimumTouchTarget),
      );
    }
    expect(
      tester.getSize(find.byKey(const ValueKey('primary-action'))).height,
      greaterThanOrEqualTo(AppSizes.controlHeight),
    );
    for (final key in const [
      'primary-action',
      'tonal-action',
      'outlined-action',
      'destructive-action',
    ]) {
      expect(
        tester.getSize(find.byKey(ValueKey(key))).height,
        greaterThanOrEqualTo(AppSizes.controlHeight),
      );
    }
    expect(
      tester
          .widget<AppButton>(find.byKey(const ValueKey('disabled-action')))
          .enabled,
      isFalse,
    );

    await tester.tap(find.byKey(const ValueKey('primary-action')));
    await tester.tap(find.byKey(const ValueKey('loading-action')));
    await tester.tap(find.byKey(const ValueKey('loading-action')));
    await tester.pump();

    expect(taps, 1);
    expect(
      tester.getSemantics(find.byKey(const ValueKey('loading-action'))).label,
      contains('Building the plan'),
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('loading-action')),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('outlined-action')),
        matching: find.byType(OutlinedButton),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('text-action')),
        matching: find.byType(TextButton),
      ),
      findsOneWidget,
    );
    semanticsHandle.dispose();
  });

  testWidgets('app buttons keep labels when loading without a loadingLabel', (
    tester,
  ) async {
    await tester.pumpWidget(
      componentTestApp(
        child: AppButton.primary(
          key: const ValueKey('waiting-action'),
          label: 'Plan requested',
          loading: true,
          onPressed: null,
          alignStart: true,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );

    expect(find.text('Plan requested'), findsOneWidget);
    final filled = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(filled.style?.alignment, Alignment.centerLeft);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('waiting-action')),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );
  });

  testWidgets('action groups keep the primary action last and stack safely', (
    tester,
  ) async {
    Future<void> pump({required double width, required double textScale}) {
      return tester.pumpWidget(
        componentTestApp(
          textScale: textScale,
          child: SizedBox(
            width: width,
            child: AppActionGroup(
              primary: AppButton.primary(
                key: const ValueKey('group-primary'),
                label: 'Continue',
                onPressed: () {},
              ),
              secondary: [
                AppButton.outlined(
                  key: const ValueKey('group-secondary'),
                  label: 'Back',
                  onPressed: () {},
                ),
              ],
            ),
          ),
        ),
      );
    }

    await pump(width: 420, textScale: 1);
    final horizontalSecondary = tester.getTopLeft(
      find.byKey(const ValueKey('group-secondary')),
    );
    final horizontalPrimary = tester.getTopLeft(
      find.byKey(const ValueKey('group-primary')),
    );
    expect(horizontalPrimary.dy, horizontalSecondary.dy);
    expect(horizontalPrimary.dx, greaterThan(horizontalSecondary.dx));

    for (final scenario in const [
      (width: 320.0, textScale: 1.0),
      (width: 420.0, textScale: 1.6),
      (width: 320.0, textScale: 2.0),
    ]) {
      await pump(width: scenario.width, textScale: scenario.textScale);
      final stackedSecondary = tester.getTopLeft(
        find.byKey(const ValueKey('group-secondary')),
      );
      final stackedPrimary = tester.getTopLeft(
        find.byKey(const ValueKey('group-primary')),
      );
      final readingOrder = find
          .byType(AppButton)
          .evaluate()
          .map((element) => (element.widget.key! as ValueKey<String>).value);
      expect(stackedPrimary.dy, greaterThan(stackedSecondary.dy));
      expect(readingOrder, ['group-secondary', 'group-primary']);
      expect(
        tester.getBottomRight(find.byKey(const ValueKey('group-primary'))).dy,
        lessThan(600),
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('loading preserves each button palette and blocks callbacks', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(
      componentTestApp(
        child: ListView(
          children: [
            for (final button in [
              AppButton.primary(
                key: const ValueKey('loading-primary'),
                label: 'Primary',
                loading: true,
                onPressed: () => taps += 1,
              ),
              AppButton.tonal(
                key: const ValueKey('loading-tonal'),
                label: 'Tonal',
                loading: true,
                onPressed: () => taps += 1,
              ),
              AppButton.outlined(
                key: const ValueKey('loading-outlined'),
                label: 'Outlined',
                loading: true,
                onPressed: () => taps += 1,
              ),
              AppButton.text(
                key: const ValueKey('loading-text'),
                label: 'Text',
                loading: true,
                onPressed: () => taps += 1,
              ),
              AppButton.destructive(
                key: const ValueKey('loading-destructive'),
                label: 'Destructive',
                loading: true,
                onPressed: () => taps += 1,
              ),
            ])
              button,
          ],
        ),
      ),
    );

    for (final key in const [
      'loading-primary',
      'loading-tonal',
      'loading-outlined',
      'loading-text',
      'loading-destructive',
    ]) {
      await tester.tap(find.byKey(ValueKey(key)));
    }
    await tester.pump();
    expect(taps, 0);

    final colors = buildTomezaLightTheme().colorScheme;
    ButtonStyle styleFor(String key) => tester
        .widget<ButtonStyleButton>(
          find.descendant(
            of: find.byKey(ValueKey(key)),
            matching: find.byWidgetPredicate(
              (widget) => widget is ButtonStyleButton,
            ),
          ),
        )
        .style!;
    const disabled = {WidgetState.disabled};
    expect(
      styleFor('loading-primary').backgroundColor?.resolve(disabled),
      colors.primary,
    );
    expect(
      styleFor('loading-tonal').backgroundColor?.resolve(disabled),
      colors.secondaryContainer,
    );
    expect(
      styleFor('loading-outlined').foregroundColor?.resolve(disabled),
      colors.onSurface,
    );
    expect(
      styleFor('loading-text').foregroundColor?.resolve(disabled),
      colors.primary,
    );
    expect(
      styleFor('loading-destructive').backgroundColor?.resolve(disabled),
      colors.error,
    );
  });

  testWidgets('semantic tones and cards work in both themes', (tester) async {
    for (final mode in const [ThemeMode.light, ThemeMode.dark]) {
      late AppSemanticColors semantic;
      await tester.pumpWidget(
        componentTestApp(
          themeMode: mode,
          child: Builder(
            builder: (context) {
              semantic = AppSemanticColors.of(context);
              return const Column(
                children: [
                  AppCard(
                    key: ValueKey('warning-card'),
                    tone: AppTone.warning,
                    child: Text('Payment is pending'),
                  ),
                  AppInlineNotice(
                    title: 'Saved',
                    message: 'Your changes are safe.',
                    tone: AppTone.success,
                  ),
                  AppCard(
                    key: ValueKey('compact-info-card'),
                    density: AppCardDensity.compact,
                    tone: AppTone.info,
                    child: Text('More information'),
                  ),
                ],
              );
            },
          ),
        ),
      );

      expect(find.text('Payment is pending'), findsOneWidget);
      expect(find.text('Your changes are safe.'), findsOneWidget);
      expect(
        _contrast(semantic.onWarningContainer, semantic.warningContainer),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrast(semantic.onSuccessContainer, semantic.successContainer),
        greaterThanOrEqualTo(4.5),
      );
      final theme = mode == ThemeMode.light
          ? buildTomezaLightTheme()
          : buildTomezaDarkTheme();
      final scheme = theme.colorScheme;
      for (final pair in [
        (scheme.onSurfaceVariant, scheme.surfaceContainerHigh),
        (semantic.onInfoContainer, semantic.infoContainer),
        (semantic.onSuccessContainer, semantic.successContainer),
        (semantic.onWarningContainer, semantic.warningContainer),
        (scheme.onErrorContainer, scheme.errorContainer),
      ]) {
        expect(_contrast(pair.$1, pair.$2), greaterThanOrEqualTo(4.5));
      }
      expect(
        tester
            .widgetList<Padding>(
              find.descendant(
                of: find.byKey(const ValueKey('compact-info-card')),
                matching: find.byType(Padding),
              ),
            )
            .map((widget) => widget.padding),
        contains(const EdgeInsets.all(AppSpacing.sm)),
      );
      expect(tester.takeException(), isNull);
    }
  });

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
      tester
          .widget<Padding>(
            find
                .descendant(
                  of: find.byType(AppEmptyState),
                  matching: find.byType(Padding),
                )
                .first,
          )
          .padding,
      const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
    );
    expect(
      tester
          .widget<Padding>(
            find
                .descendant(
                  of: find.byType(AppErrorState),
                  matching: find.byType(Padding),
                )
                .first,
          )
          .padding,
      const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
    );
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
                  AppStatusBadge(label: 'Needs attention', tone: AppTone.error),
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
          builder: (context) => AppButton.primary(
            label: 'Open dialog',
            onPressed: () async {
              confirmed = await showAppConfirmationDialog(
                context,
                title: 'Delete this project?',
                message: 'This removes generated files from your account.',
                confirmLabel: 'Delete project',
                destructive: true,
              );
            },
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open dialog'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete project'));
    await tester.pumpAndSettle();

    expect(confirmed, isTrue);

    await tester.tap(find.text('Open dialog'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(confirmed, isFalse);
  });
}

double _contrast(Color first, Color second) {
  final lighter = first.computeLuminance() > second.computeLuminance()
      ? first
      : second;
  final darker = identical(lighter, first) ? second : first;
  return (lighter.computeLuminance() + 0.05) /
      (darker.computeLuminance() + 0.05);
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
