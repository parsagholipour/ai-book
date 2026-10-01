import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/book_cover.dart';
import 'package:tomeza/features/projects/presentation/book_shelf.dart';

import 'book_shelf_test.dart' show billingWith, shelfProject, shelfTestApp;

// How the drawer's shelf lays its books out: covers of one height, each
// unfinished book's state on its cover, and a slice of the next cover saying
// "scroll".

void main() {
  testWidgets('the state sits on the cover, in its top-left corner', (
    tester,
  ) async {
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'long',
          title: 'A Long Title About The Sea And Everything In It',
          status: 'generating',
          hasPlan: true,
          progressPercent: 89,
          updatedAt: DateTime.utc(2026, 6, 3),
        ),
        shelfProject(
          id: 'short',
          title: 'Test',
          status: 'failed',
          hasPlan: true,
          updatedAt: DateTime.utc(2026, 6, 2),
        ),
      ]),
    );
    await tester.pumpAndSettle();

    final covers = find.byType(BookCover);
    final first = tester.getRect(covers.first);
    final last = tester.getRect(covers.last);
    // One height whatever the title wraps to: nothing under a title but text.
    expect(first.height, last.height);
    for (final (label, cover) in [('89%', first), ('Failed', last)]) {
      final badge = tester.getRect(find.text(label));
      expect(cover.contains(badge.topLeft), isTrue, reason: label);
      expect(badge.left - cover.left, lessThan(cover.width / 3), reason: label);
      expect(badge.top - cover.top, lessThan(cover.height / 4), reason: label);
      // Never wrapped: a word broken across two lines of a badge this narrow
      // breaks mid-letter.
      expect(tester.widget<Text>(find.text(label)).maxLines, 1);
    }
  });

  testWidgets('a full shelf shows a clear slice of the next cover', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          projectsProvider.overrideWith(
            (ref) async => [
              for (var i = 0; i < 5; i++)
                shelfProject(
                  id: 'book-$i',
                  title: 'Book $i',
                  status: 'complete',
                  hasPlan: true,
                  exportsReady: true,
                ),
            ],
          ),
          projectStatusProvider.overrideWith(
            (ref, id) => const Stream<MobileProjectStatus>.empty(),
          ),
          billingProvider.overrideWith((ref) async => billingWith(900)),
        ],
        // The drawer's own width.
        child: const MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(width: 304, child: BookShelf()),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Three fixed covers once overshot the drawer by 4dp, which read as a
    // layout bug rather than "scroll for more".
    final cut = tester
        .widgetList<BookCover>(find.byType(BookCover))
        .map((cover) => tester.getRect(find.byWidget(cover)))
        .firstWhere((rect) => rect.right > 304);
    final shown = (304 - cut.left) / cut.width;
    expect(shown, inInclusiveRange(0.3, 0.6));
  });

  testWidgets('the shelf lays out at large text without overflowing', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(
      shelfTestApp([
        shelfProject(
          id: 'broken',
          title: 'A Book With A Fairly Long Name',
          status: 'failed',
          hasPlan: true,
        ),
        shelfProject(
          id: 'writing',
          title: 'Still Writing',
          status: 'generating',
          hasPlan: true,
          progressPercent: 42,
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Failed'), findsOneWidget);
    expect(find.text('42%'), findsOneWidget);
  });
}
