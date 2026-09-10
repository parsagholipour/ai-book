import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/book_library_screen.dart';

import 'app_test_fixtures.dart';

void main() {
  testWidgets(
    'Your books closes the navbar drawer and opens the library route',
    (tester) async {
      await tester.pumpWidget(
        testApp(
          authRepository: FakeAuthRepository(initialSession: fakeSession()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('drawer-books-row')));
      await tester.pumpAndSettle();

      expect(find.byType(BookLibraryScreen), findsOneWidget);
      expect(find.text('No books yet'), findsOneWidget);

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(BookLibraryScreen), findsNothing);
      expect(find.byKey(const ValueKey('drawer-books-row')), findsNothing);
      expect(find.byKey(const ValueKey('creationBriefHeader')), findsWidgets);
    },
  );
}
