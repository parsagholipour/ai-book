import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/branch_navigator.dart';
import 'package:tomeza/shared/ui/touch_target.dart';

void main() {
  Widget host(BranchNavigator navigator) {
    return MaterialApp(home: Scaffold(body: Center(child: navigator)));
  }

  testWidgets('shows the branch position between the arrows', (tester) async {
    await tester.pumpWidget(
      host(
        BranchNavigator(
          branch: const MobileProjectChatBranch(
            index: 2,
            total: 3,
            canGoPrevious: true,
            canGoNext: true,
          ),
          foreground: Colors.black,
          switching: false,
          onPrevious: () {},
          onNext: () {},
        ),
      ),
    );

    expect(find.text('2/3'), findsOneWidget);
    expect(find.byIcon(Icons.chevron_left), findsOneWidget);
    expect(find.byIcon(Icons.chevron_right), findsOneWidget);
  });

  testWidgets('taps invoke the previous/next callbacks', (tester) async {
    var previous = 0;
    var next = 0;
    await tester.pumpWidget(
      host(
        BranchNavigator(
          branch: const MobileProjectChatBranch(
            index: 2,
            total: 3,
            canGoPrevious: true,
            canGoNext: true,
          ),
          foreground: Colors.black,
          switching: false,
          onPrevious: () => previous++,
          onNext: () => next++,
        ),
      ),
    );

    await tester.tap(find.byTooltip('Previous branch'));
    await tester.tap(find.byTooltip('Next branch'));

    expect(previous, 1);
    expect(next, 1);
  });

  testWidgets('arrows disable at the ends of the sibling range', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        BranchNavigator(
          branch: const MobileProjectChatBranch(
            index: 1,
            total: 2,
            canGoPrevious: false,
            canGoNext: true,
          ),
          foreground: Colors.black,
          switching: false,
          onPrevious: () {},
          onNext: () {},
        ),
      ),
    );

    IconButton buttonWithTooltip(String tooltip) => tester.widget<IconButton>(
      find.ancestor(
        of: find.byTooltip(tooltip),
        matching: find.byType(IconButton),
      ),
    );
    expect(buttonWithTooltip('Previous branch').onPressed, isNull);
    expect(buttonWithTooltip('Next branch').onPressed, isNotNull);
  });

  testWidgets('both arrows disable while a switch is in flight', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        BranchNavigator(
          branch: const MobileProjectChatBranch(
            index: 2,
            total: 3,
            canGoPrevious: true,
            canGoNext: true,
          ),
          foreground: Colors.black,
          switching: true,
          onPrevious: () {},
          onNext: () {},
        ),
      ),
    );

    IconButton buttonWithTooltip(String tooltip) => tester.widget<IconButton>(
      find.ancestor(
        of: find.byTooltip(tooltip),
        matching: find.byType(IconButton),
      ),
    );
    expect(buttonWithTooltip('Previous branch').onPressed, isNull);
    expect(buttonWithTooltip('Next branch').onPressed, isNull);
  });

  testWidgets('the arrows are full-size touch targets that keep their size', (
    tester,
  ) async {
    // They draw at 20dp in a 22dp box; a 48dp box made every bubble with
    // branches taller, and 22dp of touch was easy to miss.
    var previous = 0;
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: TouchTargetRegion(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: BranchNavigator(
                  branch: const MobileProjectChatBranch(
                    index: 2,
                    total: 3,
                    canGoPrevious: true,
                    canGoNext: true,
                  ),
                  foreground: Colors.black,
                  switching: false,
                  onPrevious: () => previous++,
                  onNext: () {},
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(tester.getSize(find.byTooltip('Previous branch')).height, 22);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));

    // A touch 8dp above the drawn arrow still reaches it.
    final arrow = tester.getRect(find.byTooltip('Previous branch'));
    await tester.tapAt(arrow.topCenter - const Offset(0, 8));
    expect(previous, 1);
    handle.dispose();
  });
}
