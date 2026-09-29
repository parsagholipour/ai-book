import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderClipRect;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/shared/ui/app_components.dart';
import 'package:tomeza/shared/ui/feedback/app_feedback.dart';
import 'package:tomeza/shared/ui/motion.dart';

Widget _app(
  Widget child, {
  bool reducedMotion = false,
  ThemeMode mode = ThemeMode.light,
  double textScale = 1,
}) {
  return MaterialApp(
    theme: buildTomezaLightTheme(),
    darkTheme: buildTomezaDarkTheme(),
    themeMode: mode,
    builder: (context, appChild) => MediaQuery(
      data: MediaQuery.of(context).copyWith(
        disableAnimations: reducedMotion,
        textScaler: TextScaler.linear(textScale),
      ),
      child: appChild!,
    ),
    home: Scaffold(body: SafeArea(child: child)),
  );
}

void main() {
  _popupRegression();
  _switcherShadow();
  group('AppCard', () {
    testWidgets('is a plain surface until it is given a tap', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_app(const AppCard(child: Text('Plain'))));

      expect(find.byType(InkWell), findsNothing);
      expect(find.byType(AppPressScale), findsNothing);
      expect(find.byType(Semantics), isNot(findsNothing));
      handle.dispose();
    });

    testWidgets('onTap makes it a button with ink, a press and semantics', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      var taps = 0;
      await tester.pumpWidget(
        _app(
          AppCard(
            key: const ValueKey('card'),
            semanticLabel: 'Open the book',
            onTap: () => taps += 1,
            child: const Text('Book'),
          ),
        ),
      );

      await tester.tap(find.text('Book'));
      expect(taps, 1);
      expect(find.byType(InkWell), findsOneWidget);
      expect(
        tester.getSemantics(find.byType(InkWell)),
        matchesSemantics(
          label: 'Open the book',
          isButton: true,
          hasTapAction: true,
        ),
      );
      handle.dispose();
    });

    testWidgets('selected draws the brand fill and reports selection', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _app(
          const AppCard(
            key: ValueKey('card'),
            selected: true,
            semanticLabel: 'Chosen',
            child: Text('Chosen'),
          ),
        ),
      );

      final colors = buildTomezaLightTheme().colorScheme;
      expect(
        tester.widget<Card>(find.byType(Card)).color,
        colors.primaryContainer,
      );
      expect(
        tester.getSemantics(find.byKey(const ValueKey('card'))),
        matchesSemantics(
          label: 'Chosen',
          isSelected: true,
          hasSelectedState: true,
        ),
      );
      handle.dispose();
    });

    testWidgets('a tone card lies flat while a neutral one lifts', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          const Column(
            children: [
              AppCard(child: Text('neutral')),
              AppCard(tone: AppTone.info, child: Text('info')),
            ],
          ),
        ),
      );
      final cards = tester.widgetList<Card>(find.byType(Card)).toList();
      expect(cards.first.elevation, isNull, reason: 'takes the theme lift');
      expect(cards.last.elevation, 0);
    });
  });

  group('AppPressScale', () {
    testWidgets('shrinks while a finger is down and returns on release', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          const Center(
            child: AppPressScale(
              child: ColoredBox(
                color: Colors.red,
                child: SizedBox(width: 100, height: 60),
              ),
            ),
          ),
        ),
      );
      double scale() =>
          tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale;

      expect(scale(), 1);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(AppPressScale)),
      );
      await tester.pump();
      expect(scale(), AppMotion.pressedScale);
      await gesture.up();
      await tester.pump();
      expect(scale(), 1);
    });

    testWidgets('lets go once the finger has become a scroll', (tester) async {
      await tester.pumpWidget(
        _app(
          const Center(
            child: AppPressScale(
              child: ColoredBox(
                color: Colors.red,
                child: SizedBox(width: 100, height: 60),
              ),
            ),
          ),
        ),
      );
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(AppPressScale)),
      );
      await tester.pump();
      await gesture.moveBy(const Offset(0, 40));
      await tester.pump();

      expect(tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale, 1);
      await gesture.up();
    });

    testWidgets('does nothing when disabled or when motion is reduced', (
      tester,
    ) async {
      Widget pressable({required bool enabled, bool reduced = false}) => _app(
        Center(
          child: AppPressScale(
            enabled: enabled,
            child: const ColoredBox(
              color: Colors.red,
              child: SizedBox(width: 100, height: 60),
            ),
          ),
        ),
        reducedMotion: reduced,
      );
      double scale() =>
          tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale;

      for (final (enabled, reduced) in [(false, false), (true, true)]) {
        await tester.pumpWidget(pressable(enabled: enabled, reduced: reduced));
        final gesture = await tester.startGesture(
          tester.getCenter(find.byType(AppPressScale)),
        );
        await tester.pump();
        expect(scale(), 1);
        await gesture.up();
      }
    });
  });

  group('AppButton', () {
    testWidgets('haptic is opt-in and fires once per accepted tap', (
      tester,
    ) async {
      final calls = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') {
            calls.add(call.arguments as String);
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      var taps = 0;
      await tester.pumpWidget(
        _app(
          Column(
            children: [
              AppButton.primary(label: 'Quiet', onPressed: () => taps += 1),
              AppButton.primary(
                label: 'Felt',
                haptic: true,
                onPressed: () => taps += 1,
              ),
            ],
          ),
        ),
      );

      await tester.tap(find.text('Quiet'));
      await tester.pump();
      expect(calls, isEmpty);

      await tester.tap(find.text('Felt'));
      await tester.pump();
      expect(taps, 2);
      expect(calls, ['HapticFeedbackType.lightImpact']);
    });

    testWidgets('a loading button keeps its label and settles its width', (
      tester,
    ) async {
      Widget button({required bool loading}) => _app(
        Align(
          alignment: Alignment.topLeft,
          child: AppButton.primary(
            key: const ValueKey('b'),
            label: 'Send',
            loading: loading,
            onPressed: () {},
          ),
        ),
      );
      await tester.pumpWidget(button(loading: false));
      final resting = tester.getSize(find.byKey(const ValueKey('b'))).width;

      await tester.pumpWidget(button(loading: true));
      expect(find.text('Send'), findsOneWidget);
      // Eases rather than jumping: the first frame is still the old width.
      expect(tester.getSize(find.byKey(const ValueKey('b'))).width, resting);
      await tester.pump(AppMotion.fast * 2);
      expect(
        tester.getSize(find.byKey(const ValueKey('b'))).width,
        greaterThan(resting),
      );
    });
  });

  group('skeletons', () {
    testWidgets('a group announces once and hides its blocks', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _app(const AppSkeletonList(itemCount: 3, label: 'Loading your books')),
      );

      expect(find.bySemanticsLabel('Loading your books'), findsOneWidget);
      expect(find.byType(AppSkeleton), findsNWidgets(9));
      handle.dispose();
    });

    testWidgets('sweep animates normally and stops under reduced motion', (
      tester,
    ) async {
      await tester.pumpWidget(_app(const AppSkeletonCard(mediaHeight: 120)));
      expect(find.byType(ShaderMask), findsOneWidget);
      expect(tester.hasRunningAnimations, isTrue);

      await tester.pumpWidget(
        _app(const AppSkeletonCard(mediaHeight: 120), reducedMotion: true),
      );
      // Settles: nothing keeps a ticker alive, and no sweep is drawn.
      await tester.pumpAndSettle();
      expect(find.byType(ShaderMask), findsNothing);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('the pulse shimmer stops in reduced motion too', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(const AppShimmer(child: SizedBox(width: 40, height: 40))),
      );
      expect(tester.hasRunningAnimations, isTrue);

      await tester.pumpWidget(
        _app(
          const AppShimmer(child: SizedBox(width: 40, height: 40)),
          reducedMotion: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('lays out in both themes at large text without overflow', (
      tester,
    ) async {
      for (final mode in ThemeMode.values.where((m) => m != ThemeMode.system)) {
        await tester.pumpWidget(
          _app(
            const SingleChildScrollView(
              child: Column(
                children: [
                  AppSkeletonList(leading: AppSkeletonLeading.circle),
                  AppSkeletonCardList(count: 2, mediaHeight: 100),
                ],
              ),
            ),
            mode: mode,
            textScale: 2,
          ),
        );
        expect(tester.takeException(), isNull);
      }
    });
  });

  group('state screens', () {
    testWidgets('an empty state offers a primary and a secondary action', (
      tester,
    ) async {
      var primary = 0;
      var secondary = 0;
      await tester.pumpWidget(
        _app(
          AppEmptyState(
            title: 'No books yet',
            message: 'Start one.',
            actionLabel: 'Start a book',
            onAction: () => primary += 1,
            secondaryLabel: 'Import a manuscript',
            onSecondary: () => secondary += 1,
          ),
        ),
      );

      await tester.tap(find.text('Start a book'));
      await tester.tap(find.text('Import a manuscript'));
      expect(primary, 1);
      expect(secondary, 1);
      expect(find.widgetWithText(FilledButton, 'Start a book'), findsOneWidget);
      expect(
        find.widgetWithText(TextButton, 'Import a manuscript'),
        findsOneWidget,
      );
    });

    testWidgets('an illustration replaces the icon halo', (tester) async {
      await tester.pumpWidget(
        _app(
          const AppEmptyState(
            title: 'Nothing',
            message: 'Here',
            icon: Icons.book,
            illustration: SizedBox(key: ValueKey('art'), width: 80, height: 80),
          ),
        ),
      );
      expect(find.byKey(const ValueKey('art')), findsOneWidget);
      expect(find.byIcon(Icons.book), findsNothing);
    });

    testWidgets('compact states are shorter than full ones', (tester) async {
      Future<double> heightOf({required bool compact}) async {
        await tester.pumpWidget(
          _app(
            AppErrorState(
              key: const ValueKey('e'),
              title: 'Nope',
              message: 'It broke.',
              onRetry: () {},
              compact: compact,
            ),
          ),
        );
        await tester.pumpAndSettle();
        return tester.getSize(find.byType(AppEntrance)).height;
      }

      expect(
        await heightOf(compact: true),
        lessThan(await heightOf(compact: false)),
      );
    });

    testWidgets('an error state has a way out besides retrying', (
      tester,
    ) async {
      var backed = false;
      await tester.pumpWidget(
        _app(
          AppErrorState(
            title: 'Could not open',
            message: 'Try later.',
            onRetry: () {},
            secondaryLabel: 'Go back',
            onSecondary: () => backed = true,
          ),
        ),
      );
      await tester.tap(find.text('Go back'));
      expect(backed, isTrue);
    });

    testWidgets(
      'a loading state can show a skeleton and still say it is loading',
      (tester) async {
        final handle = tester.ensureSemantics();
        await tester.pumpWidget(
          _app(AppLoadingState.list(message: 'Loading chapters', itemCount: 2)),
        );
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.bySemanticsLabel('Loading chapters'), findsOneWidget);
        handle.dispose();
      },
    );
  });

  group('notices and rows', () {
    testWidgets('each tone brings its own glyph and a dismiss works', (
      tester,
    ) async {
      var dismissed = 0;
      await tester.pumpWidget(
        _app(
          SingleChildScrollView(
            child: Column(
              children: [
                for (final tone in AppTone.values)
                  AppInlineNotice(
                    title: tone.name,
                    message: 'msg',
                    tone: tone,
                    onDismiss: tone == AppTone.error
                        ? () => dismissed += 1
                        : null,
                  ),
              ],
            ),
          ),
        ),
      );
      for (final tone in AppTone.values) {
        expect(find.byIcon(AppInlineNotice.iconFor(tone)), findsWidgets);
      }
      expect(
        AppInlineNotice.iconFor(AppTone.success),
        Icons.check_circle_outline,
      );
      await tester.tap(find.byTooltip('Close'));
      expect(dismissed, 1);
    });

    testWidgets('a settings value sits against the trailing edge', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          AppSettingsSection(
            title: 'Account',
            footer: 'Applies on this device.',
            children: [
              AppSettingsRow(
                icon: Icons.palette_outlined,
                title: 'Appearance',
                value: 'System',
                onTap: () {},
              ),
              AppSettingsRow(
                icon: Icons.logout,
                title: 'Sign out',
                destructive: true,
                onTap: () {},
              ),
            ],
          ),
        ),
      );

      final value = tester.getTopRight(find.text('System')).dx;
      final chevron = tester
          .getTopLeft(find.byIcon(Icons.chevron_right).first)
          .dx;
      // It used to float at the row's midpoint, a full column-width away.
      expect(chevron - value, lessThan(16));
      expect(find.text('Applies on this device.'), findsOneWidget);
    });
  });

  group('sheets and dialogs', () {
    testWidgets('the sheet scaffold pins its footer and scrolls the body', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var closed = false;
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showAppBottomSheet<void>(
                context,
                builder: (context) => AppSheetScaffold(
                  title: 'Edit page',
                  subtitle: 'Page 3',
                  onClose: () => closed = true,
                  footer: AppButton.primary(label: 'Save', onPressed: () {}),
                  children: [for (var i = 0; i < 40; i++) Text('row $i')],
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Edit page'), findsOneWidget);
      expect(find.text('Page 3'), findsOneWidget);
      expect(find.text('Save'), findsOneWidget, reason: 'footer stays in view');
      expect(
        tester.getTopLeft(find.text('row 39')).dy,
        greaterThan(700),
        reason: 'the body scrolls',
      );
      final height = tester.getSize(find.byType(AppSheetScaffold)).height;
      expect(height, lessThanOrEqualTo(700 * 0.9 + 0.5));

      await tester.tap(find.byTooltip('Close'));
      expect(closed, isTrue);
    });

    testWidgets('the sheet scaffold rises above the keyboard', (tester) async {
      tester.view.physicalSize = const Size(400, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      Future<void> pump(double keyboard) => tester.pumpWidget(
        MaterialApp(
          theme: buildTomezaLightTheme(),
          home: MediaQuery(
            data: MediaQueryData(
              size: const Size(400, 800),
              viewInsets: EdgeInsets.only(bottom: keyboard),
            ),
            child: const Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: AppSheetScaffold(
                  title: 'Rename',
                  children: [TextField(key: ValueKey('field'))],
                ),
              ),
            ),
          ),
        ),
      );
      await pump(0);
      final resting = tester
          .getBottomLeft(find.byKey(const ValueKey('field')))
          .dy;
      await pump(300);
      await tester.pumpAndSettle();
      expect(
        tester.getBottomLeft(find.byKey(const ValueKey('field'))).dy,
        closeTo(resting - 300, 1),
      );
    });

    testWidgets('an action sheet with a title shows the header first', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showAppActionSheet<void>(
                context,
                title: 'Book options',
                builder: (_) => const ListTile(title: Text('Rename')),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Book options'), findsOneWidget);
      expect(find.text('Rename'), findsOneWidget);
    });

    testWidgets('a destructive dialog gets a warning glyph and stacks safely', (
      tester,
    ) async {
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showAppConfirmationDialog(
                context,
                title: 'Delete this book?',
                message: 'This cannot be undone.',
                confirmLabel: 'Delete the book and every file in it',
                destructive: true,
              ),
              child: const Text('open'),
            ),
          ),
          textScale: 1.6,
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
      expect(find.text('Delete the book and every file in it'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('AppMotion', () {
    testWidgets('adapt collapses a duration under reduced motion', (
      tester,
    ) async {
      late Duration calm;
      late Duration normal;
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) {
              normal = AppMotion.adapt(context, AppMotion.medium);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) {
              calm = AppMotion.adapt(context, AppMotion.medium);
              return const SizedBox.shrink();
            },
          ),
          reducedMotion: true,
        ),
      );
      expect(normal, AppMotion.medium);
      expect(calm, Duration.zero);
    });

    test('the durations climb', () {
      expect(AppMotion.instant, lessThan(AppMotion.fast));
      expect(AppMotion.fast, lessThan(AppMotion.medium));
      expect(AppMotion.medium, lessThan(AppMotion.page));
      expect(AppMotion.page, lessThan(AppMotion.slow));
    });
  });
}

void _popupRegression() {
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets(
      'a checked popup menu with an initialValue builds (${mode.name})',
      (tester) async {
        // A ListTile theme with a non-transparent tile colour makes ListTile
        // assert whenever the menu highlights `initialValue` (it wraps that item
        // in a ColoredBox). CheckedPopupMenuItem is built on ListTile.
        await tester.pumpWidget(
          _app(
            Center(
              child: PopupMenuButton<int>(
                initialValue: 1,
                itemBuilder: (context) => const [
                  CheckedPopupMenuItem<int>(
                    value: 1,
                    checked: true,
                    child: Text('One'),
                  ),
                  CheckedPopupMenuItem<int>(value: 2, child: Text('Two')),
                ],
              ),
            ),
            mode: mode,
          ),
        );
        await tester.tap(find.byType(PopupMenuButton<int>));
        await tester.pumpAndSettle();

        expect(find.text('One'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }
}

void _switcherShadow() {
  testWidgets('AppSwitcher lets a settled child cast its shadow', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const Padding(
          padding: EdgeInsets.all(24),
          child: AppSwitcher(child: AppCard(child: Text('Lifted'))),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final clip = tester.renderObject<RenderClipRect>(
      find.descendant(
        of: find.byType(AppSwitcher),
        matching: find.byType(ClipRect),
      ),
    );
    final rect = clip.clipper!.getClip(clip.size);
    // A `SizeTransition` clipped at exactly the child's box, which sliced the
    // card's shadow off along its edges.
    expect(rect.left, lessThan(-16));
    expect(rect.top, lessThan(-16));
    expect(rect.right, greaterThan(clip.size.width + 16));
    expect(rect.bottom, greaterThan(clip.size.height + 16));
  });

  testWidgets('AppSwitcher still swaps its child', (tester) async {
    Widget host(String label) =>
        _app(AppSwitcher(child: Text(label, key: ValueKey(label))));
    await tester.pumpWidget(host('first'));
    await tester.pumpWidget(host('second'));
    await tester.pumpAndSettle();

    expect(find.text('first'), findsNothing);
    expect(find.text('second'), findsOneWidget);
  });
}
