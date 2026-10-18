import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

// The end of a chapter that is not the last leads on to the one after it.

FakeStudioRepository _repo({String secondTitle = 'The Harbour'}) =>
    FakeStudioRepository(
      chapters: [
        FakeStudioChapter(
          id: 'c1',
          title: 'Arrival',
          // Long enough that its end is well below the first screen.
          markdown: List.filled(40, 'She came by sea.').join('\n\n'),
          // Written in last, so it is the one that opens.
          updatedAt: DateTime.utc(2026, 10, 1),
        ),
        FakeStudioChapter(
          id: 'c2',
          title: secondTitle,
          // Long too, or any offset carried over would clamp to its top.
          markdown: List.filled(40, 'Boats came home slowly.').join('\n\n'),
        ),
      ],
    );

Finder _next() => find.byKey(const ValueKey('studio-chapter-end-next'));
Finder _add() => find.byKey(const ValueKey('studio-chapter-end-add'));

// The editor's own scrollable; every text field inside it has one too.
double _scrollOffset(WidgetTester tester, String chapterId) => tester
    .state<ScrollableState>(
      find
          .descendant(
            of: find.byKey(PageStorageKey('studio-editor-scroll-$chapterId')),
            matching: find.byType(Scrollable),
          )
          .first,
    )
    .position
    .pixels;

void main() {
  testWidgets('an earlier chapter ends with the next one, by name', (
    tester,
  ) async {
    final repo = _repo();
    await tester.pumpWidget(studioTestApp(repo: repo));
    await settle(tester);

    expect(
      find.descendant(of: _next(), matching: find.text('NEXT · CHAPTER 2')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _next(), matching: find.text('The Harbour')),
      findsOneWidget,
    );
    // Adding one in between is still there, beneath it.
    expect(
      find.descendant(
        of: _add(),
        matching: find.text('Add a chapter after this one'),
      ),
      findsOneWidget,
    );

    await tester.enterText(bodyFields().first, 'She came by sea, alone.');
    await tester.ensureVisible(_next());
    await settle(tester);
    expect(_scrollOffset(tester, 'c1'), greaterThan(0));
    await tester.tap(_next());
    await settle(tester);

    // What was typed is saved before the next chapter opens, and it opens at
    // its top rather than at the depth the last one was left at.
    expect(repo.saves.single.markdown, startsWith('She came by sea, alone.'));
    expect(find.textContaining('Chapter 2 of 2'), findsOneWidget);
    expect(_scrollOffset(tester, 'c2'), 0);
    // The last chapter has no next one to show.
    expect(_next(), findsNothing);
    expect(find.text('Add chapter 3'), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('a next chapter still called by its number shows it once', (
    tester,
  ) async {
    await tester.pumpWidget(
      studioTestApp(repo: _repo(secondTitle: 'Chapter 2')),
    );
    await settle(tester);

    expect(
      find.descendant(of: _next(), matching: find.text('NEXT')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _next(), matching: find.text('Chapter 2')),
      findsOneWidget,
    );
    await closeStudio(tester);
  });
}
