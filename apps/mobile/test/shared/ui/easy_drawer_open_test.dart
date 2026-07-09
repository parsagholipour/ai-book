import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/ui/easy_drawer_open.dart';

Widget _app(GlobalKey<EasyDrawerControllerState> drawerKey) {
  return MaterialApp(
    home: Stack(
      fit: StackFit.expand,
      children: [
        Scaffold(
          appBar: AppBar(
            leading: EasyDrawerButton(controllerKey: drawerKey),
          ),
          body: ListView(
            children: List.generate(
              40,
              (i) => SizedBox(height: 48, child: Text('Row $i')),
            ),
          ),
        ),
        EasyDrawerController(
          key: drawerKey,
          child: const Drawer(child: Text('History')),
        ),
      ],
    ),
  );
}

void main() {
  testWidgets('drag follows finger from the start edge and snaps open easily', (
    tester,
  ) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(_app(drawerKey));

    final gesture = await tester.createGesture();
    await gesture.addPointer();
    await gesture.down(const Offset(12, 400));
    await tester.pump();
    expect(find.text('History'), findsNothing);

    await gesture.moveBy(const Offset(30, 0));
    await tester.pump();
    expect(find.text('History'), findsOneWidget);
    final x1 = tester
        .renderObject<RenderBox>(find.byType(Drawer))
        .localToGlobal(Offset.zero)
        .dx;
    expect(x1, isNegative);

    await gesture.moveBy(const Offset(40, 0));
    await tester.pump();
    final x2 = tester
        .renderObject<RenderBox>(find.byType(Drawer))
        .localToGlobal(Offset.zero)
        .dx;
    expect(x2, greaterThan(x1));

    await gesture.up();
    await tester.pumpAndSettle();
    expect(drawerKey.currentState!.isDrawerOpen, isTrue);
    expect(
      tester
          .renderObject<RenderBox>(find.byType(Drawer))
          .localToGlobal(Offset.zero)
          .dx,
      moreOrLessEquals(0.0),
    );
  });

  testWidgets('tiny edge drag snaps closed', (tester) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(_app(drawerKey));

    final gesture = await tester.createGesture();
    await gesture.addPointer();
    await gesture.down(const Offset(12, 400));
    await tester.pump();
    await gesture.moveBy(const Offset(20, 0));
    await tester.pump();
    expect(find.text('History'), findsOneWidget);
    await gesture.up();
    await tester.pumpAndSettle();
    expect(find.text('History'), findsNothing);
  });

  testWidgets('vertical scrolling still works', (tester) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    final scrollController = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: Stack(
          fit: StackFit.expand,
          children: [
            Scaffold(
              body: ListView(
                controller: scrollController,
                children: List.generate(
                  40,
                  (i) => SizedBox(height: 48, child: Text('Row $i')),
                ),
              ),
            ),
            EasyDrawerController(
              key: drawerKey,
              child: const Drawer(child: Text('History')),
            ),
          ],
        ),
      ),
    );

    await tester.drag(find.byType(ListView), const Offset(0, -300));
    await tester.pumpAndSettle();
    expect(find.text('History'), findsNothing);
    expect(scrollController.offset, greaterThan(200));
  });

  testWidgets('light fling from the edge opens', (tester) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(_app(drawerKey));
    await tester.flingFrom(const Offset(10, 400), const Offset(80, 0), 250);
    await tester.pumpAndSettle();
    expect(find.text('History'), findsOneWidget);
  });

  testWidgets('mid-screen horizontal drag leaves the drawer closed', (
    tester,
  ) async {
    // Horizontal gestures away from the edge belong to on-screen content
    // (chip rows, carousels), not the drawer.
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(_app(drawerKey));
    await tester.dragFrom(const Offset(300, 400), const Offset(200, 0));
    await tester.pumpAndSettle();
    expect(find.text('History'), findsNothing);
    expect(drawerKey.currentState!.isDrawerOpen, isFalse);
  });

  testWidgets('menu button opens', (tester) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(_app(drawerKey));
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    expect(find.text('History'), findsOneWidget);
  });

  testWidgets('Navigator.pop closes', (tester) async {
    final drawerKey = GlobalKey<EasyDrawerControllerState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            return Stack(
              fit: StackFit.expand,
              children: [
                const Scaffold(body: SizedBox.expand()),
                EasyDrawerController(
                  key: drawerKey,
                  child: Drawer(
                    child: ListTile(
                      title: const Text('Close me'),
                      onTap: () => Navigator.of(context).pop(),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
    drawerKey.currentState!.open();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Close me'));
    await tester.pumpAndSettle();
    expect(find.text('Close me'), findsNothing);
  });
}
