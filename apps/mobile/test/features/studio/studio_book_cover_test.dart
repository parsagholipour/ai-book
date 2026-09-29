import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/studio/data/studio_repository.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/features/studio/presentation/studio_cover_picker.dart';
import 'package:tomeza/shared/ui/authed_network_image.dart';

import '../../billing/billing_paywall_harness.dart';
import '../../projects/book_page_fixtures.dart';
import '../../support/fake_studio_repository.dart';

// Where the cover lives on the book page: on the writing card before the
// first publish, and beside the cover in the hero after it.

Future<void> _tall(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(500, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

MobileProjectDetail _written({bool published = false}) => bookProject(
  status: published ? 'complete' : 'draft',
  source: 'written',
  withPlan: published,
  pageCount: published ? 16 : 0,
  prompt: 'Author-written manuscript: The Lighthouse Letter',
  manuscript: MobileManuscriptSummary(
    wordCount: 3200,
    chapterCount: 2,
    published: published,
    hasUnpublishedChanges: false,
  ),
  exports: exportSet(available: published),
);

FakeStudioRepository _studio() => FakeStudioRepository(
  projectId: 'project-1',
  title: 'The Lighthouse Letter',
  chapters: [
    FakeStudioChapter(
      id: 'c1',
      title: 'The bottle',
      markdown: 'She found it at dawn.',
    ),
  ],
);

Future<void> _pumpPage(
  WidgetTester tester,
  FakeStudioRepository studio, {
  MobileProjectDetail? project,
}) async {
  await tester.pumpWidget(
    bookPageApp(
      visited: [],
      project: project ?? _written(),
      status: bookStatus(
        status: project == null ? 'draft' : 'complete',
        completed: project == null ? 0 : 16,
      ),
      overrides: [
        studioRepositoryProvider.overrideWithValue(studio),
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      ],
    ),
  );
}

final _coverRow = find.byKey(const ValueKey('studio-cover'));

int _fetches(FakeStudioRepository studio) =>
    studio.calls.where((call) => call == 'getManuscript').length;

void main() {
  testWidgets('the writing card shows the designed cover until there is one', (
    tester,
  ) async {
    await _tall(tester);
    await _pumpPage(tester, _studio());
    await tester.pumpAndSettle();

    expect(_coverRow, findsOneWidget);
    expect(find.text('Designed with your title and name'), findsOneWidget);
    expect(
      find.descendant(of: _coverRow, matching: find.byType(AuthedNetworkImage)),
      findsNothing,
    );
    // Before the first publish the card has the cover, not the hero.
    expect(find.byKey(const ValueKey('hero-change-cover')), findsNothing);
  });

  testWidgets('the writing card shows the author\'s cover picture', (
    tester,
  ) async {
    await _tall(tester);
    final studio = _studio()
      ..cover = const ManuscriptCover(
        source: ManuscriptCoverSource.upload,
        pending: false,
        imageUrl: '/assets/images/project-1/cover-upload-1.jpg',
      );
    await _pumpPage(tester, studio);
    await tester.pumpAndSettle();

    expect(find.text('Your own picture'), findsOneWidget);
    final image = tester.widget<AuthedNetworkImage>(
      find.descendant(of: _coverRow, matching: find.byType(AuthedNetworkImage)),
    );
    expect(image.url, '/assets/images/project-1/cover-upload-1.jpg');

    await tester.tap(_coverRow);
    await tester.pumpAndSettle();
    expect(find.text('The first thing a reader sees.'), findsOneWidget);
    expect(find.text('Generate with AI'), findsOneWidget);
  });

  testWidgets('a cover being drawn is watched from the card until it lands', (
    tester,
  ) async {
    await _tall(tester);
    final studio = _studio()
      ..cover = const ManuscriptCover(
        source: ManuscriptCoverSource.ai,
        pending: true,
      );
    await _pumpPage(tester, studio);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Being drawn…'), findsOneWidget);

    final before = _fetches(studio);
    studio.cover = const ManuscriptCover(
      source: ManuscriptCoverSource.ai,
      pending: false,
      imageUrl: '/assets/images/project-1/cover.png',
    );
    await tester.pump(studioCoverPollInterval);
    await tester.pump(const Duration(milliseconds: 300));
    expect(_fetches(studio), greaterThan(before));
    expect(find.text('Drawn with AI'), findsOneWidget);

    final settled = _fetches(studio);
    await tester.pump(studioCoverPollInterval * 2);
    expect(_fetches(studio), settled);
  });

  testWidgets('a redrawn cover shows from its new URL, not the old picture', (
    tester,
  ) async {
    // A redraw keeps cover.png; only the API's `?v=` moves, and the card must
    // follow that URL as it is rather than put a version of its own on it.
    await _tall(tester);
    final studio = _studio()
      ..cover = const ManuscriptCover(
        source: ManuscriptCoverSource.design,
        pending: true,
        imageUrl: '/assets/images/project-1/cover.png?v=one',
      );
    await _pumpPage(tester, studio);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    AuthedNetworkImage image() => tester.widget<AuthedNetworkImage>(
      find.descendant(of: _coverRow, matching: find.byType(AuthedNetworkImage)),
    );
    expect(image().url, '/assets/images/project-1/cover.png?v=one');
    expect(image().cacheBuster, isNull);

    studio.cover = const ManuscriptCover(
      source: ManuscriptCoverSource.design,
      pending: false,
      imageUrl: '/assets/images/project-1/cover.png?v=two',
    );
    await tester.pump(studioCoverPollInterval);
    await tester.pump(const Duration(milliseconds: 300));
    expect(image().url, '/assets/images/project-1/cover.png?v=two');
    expect(image().cacheBuster, isNull);
  });

  testWidgets('a published author book changes its cover from the hero', (
    tester,
  ) async {
    await _tall(tester);
    await _pumpPage(tester, _studio(), project: _written(published: true));
    await tester.pumpAndSettle();

    expect(_coverRow, findsNothing);
    await tester.tap(find.byKey(const ValueKey('hero-change-cover')));
    await tester.pumpAndSettle();
    expect(find.text('The first thing a reader sees.'), findsOneWidget);
    expect(find.text('Designed'), findsOneWidget);
  });

  testWidgets('a generated book offers no cover change', (tester) async {
    await _tall(tester);
    await _pumpPage(tester, _studio(), project: bookProject());
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('hero-change-cover')), findsNothing);
  });
}
