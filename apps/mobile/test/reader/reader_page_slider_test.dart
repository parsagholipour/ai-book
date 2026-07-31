import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/presentation/reader_page_slider.dart';

/// Puts the slider where the reader puts it and reports the height the body is
/// left with.
Future<Size> pumpWithSlider(
  WidgetTester tester, {
  required int pageCount,
}) async {
  late Size bodySize;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: LayoutBuilder(
          builder: (context, constraints) {
            bodySize = constraints.biggest;
            return const SizedBox.expand();
          },
        ),
        bottomNavigationBar: ReaderPageSlider(
          currentPage: 1,
          pageCount: pageCount,
          onChanged: (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return bodySize;
}

void main() {
  testWidgets('leaves the page room to render', (tester) async {
    // RenderSlider is sizedByParent and claims the whole bounded height it is
    // offered. An unconstrained slider in bottomNavigationBar therefore takes
    // the entire screen and the body collapses to zero — the book renders
    // nothing at all.
    final withSlider = await pumpWithSlider(tester, pageCount: 13);
    final withoutSlider = await pumpWithSlider(tester, pageCount: 1);

    expect(withSlider.height, greaterThan(0));
    expect(
      withoutSlider.height - withSlider.height,
      lessThanOrEqualTo(ReaderPageSlider.barHeight),
      reason: 'the bar must cost no more than its declared height',
    );
  });

  testWidgets('renders the position and hides for a one-page book', (
    tester,
  ) async {
    await pumpWithSlider(tester, pageCount: 13);
    expect(find.text('1 / 13'), findsOneWidget);

    await pumpWithSlider(tester, pageCount: 1);
    expect(find.byType(Slider), findsNothing);
  });

  testWidgets('reports the page the reader scrubs to', (tester) async {
    final selected = <int>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: const SizedBox.expand(),
          bottomNavigationBar: ReaderPageSlider(
            currentPage: 1,
            pageCount: 10,
            onChanged: selected.add,
          ),
        ),
      ),
    );

    await tester.drag(find.byType(Slider), const Offset(400, 0));
    await tester.pumpAndSettle();

    expect(selected, isNotEmpty);
    expect(selected.last, greaterThan(1));
  });
}
