import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// A children's story draws two pictures for every five pages, never past 12
// (`pictureBookIllustrationCount`, core's `pictureBookIllustrationCap`). The
// switch has described two older rules — every page to 12 pages then every
// other page, and a picture on every page up to 12 — and must not promise
// either.
void main() {
  testWidgets('the illustrations switch states the picture-book rule', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();
    final kids = find.text('Children’s story');
    await tester.ensureVisible(kids.first);
    await tester.tap(kids.first);
    await tester.pumpAndSettle();

    final illustrations = find.widgetWithText(
      AppToggleTile,
      'In-book illustrations',
    );
    await tester.ensureVisible(illustrations);
    expect(
      find.descendant(
        of: illustrations,
        matching: find.textContaining(
          'About 2 pictures for every 5 pages, up to 12 pictures',
        ),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('every other page'), findsNothing);
    expect(find.textContaining('A picture on every page'), findsNothing);

    await tester.teardownScreen();
  });
}
