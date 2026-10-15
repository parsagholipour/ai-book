import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// A children's story is drawn a picture per page and never past 12
// (`pictureBookIllustrationCount`, core's `min(pages, 12)`). The switch used to
// describe the old rule — every page to 12 pages, then every other page.
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
          'A picture on every page, up to 12 pictures',
        ),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('every other page'), findsNothing);

    await tester.teardownScreen();
  });
}
