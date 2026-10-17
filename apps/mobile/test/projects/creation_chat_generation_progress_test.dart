import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';
import 'package:tomeza/features/projects/domain/making_of_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/shared/ui/motion.dart';

import 'creation_chat_generation_harness.dart';
import 'making_of_stub.dart';

/// The live writing progress the chat shows after a plan is approved. Planning
/// already reports itself this way; these pin that a book does too.
void main() {
  testWidgets('generating shows the milestone list with a spinner on the '
      'active step', (tester) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        generationProgress: const MobileGenerationProgress(
          percent: 46,
          detail: 'Writing page 18 of 40',
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Preparing your chapters',
              status: 'done',
              detail: '6 chapters',
            ),
            MobileProjectStatusStep(
              key: 'write',
              label: 'Writing your pages',
              status: 'active',
              detail: '17 of 40 pages',
            ),
            MobileProjectStatusStep(
              key: 'illustrate',
              label: 'Creating your illustrations',
              status: 'pending',
            ),
            MobileProjectStatusStep(
              key: 'finish',
              label: 'Building your book',
              status: 'pending',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing page 18 of 40'), findsOneWidget);
    expect(find.text('46%'), findsOneWidget);
    expect(find.text('Preparing your chapters'), findsOneWidget);
    expect(find.text('6 chapters'), findsOneWidget);
    expect(find.text('Writing your pages'), findsOneWidget);
    expect(find.text('17 of 40 pages'), findsOneWidget);
    expect(find.text('Creating your book images'), findsOneWidget);
    expect(find.text('Building your book'), findsOneWidget);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsOneWidget,
    );

    final activeRow = find.bySemanticsLabel(
      'Writing your pages. In progress. 17 of 40 pages.',
    );
    expect(activeRow, findsOneWidget);
    expect(
      find.descendant(
        of: activeRow,
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel('Preparing your chapters. Done. 6 chapters.'),
      findsOneWidget,
    );
  });

  testWidgets('a text-only book never shows an illustration step', (
    tester,
  ) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        generationProgress: const MobileGenerationProgress(
          percent: 52,
          detail: 'Writing page 9 of 20',
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Preparing your chapters',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'write',
              label: 'Writing your pages',
              status: 'active',
            ),
            MobileProjectStatusStep(
              key: 'finish',
              label: 'Building your book',
              status: 'pending',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Writing your pages'), findsOneWidget);
    expect(find.text('Creating your illustrations'), findsNothing);
  });

  testWidgets('a cover-only book names the image step as the cover', (
    tester,
  ) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        coverEnabled: true,
        illustrationsEnabled: false,
        generationProgress: const MobileGenerationProgress(
          percent: 70,
          steps: [
            MobileProjectStatusStep(
              key: 'illustrate',
              // Even a stale server label is made exact from the flags.
              label: 'Creating your illustrations',
              status: 'active',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Creating your cover'), findsOneWidget);
    expect(find.text('Creating your illustrations'), findsNothing);
  });

  testWidgets('the bar never animates backwards on a stale tick', (
    tester,
  ) async {
    final controller = StreamController<MobileProjectStatus>();
    addTearDown(controller.close);
    await pumpGenerationChat(tester, statusStream: controller.stream);

    controller.add(generationStatus(progressPercent: 62));
    await settleEnough(tester);
    expect(find.text('62%'), findsOneWidget);

    controller.add(generationStatus(progressPercent: 55));
    await settleEnough(tester);
    expect(find.text('62%'), findsOneWidget);
    expect(find.text('55%'), findsNothing);
  });

  testWidgets('the first tick is a skeleton of the real card, not a bare '
      'spinner', (tester) async {
    final controller = StreamController<MobileProjectStatus>();
    addTearDown(controller.close);
    await pumpGenerationChat(tester, statusStream: controller.stream);

    expect(find.byType(AppShimmer), findsOneWidget);
    expect(find.bySemanticsLabel('Checking writing progress…'), findsOneWidget);

    controller.add(generationStatus());
    await settleEnough(tester);

    expect(find.byType(AppShimmer), findsNothing);
  });

  testWidgets('the leave-this-chat reassurance goes away once the book is '
      'finished', (tester) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
        currentAction: 'Ready to download.',
      ),
    );

    // A finished book is a still summary, not a progress bubble: no percent,
    // no reassurance, no checklist unless asked for.
    expect(
      find.bySemanticsLabel(RegExp(r'Ready · 3 pages · 1 image$')),
      findsOneWidget,
    );
    expect(find.text('100%'), findsNothing);
    expect(find.text('Preparing your chapters'), findsNothing);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsNothing,
    );
  });

  testWidgets('a finished book has one primary action and folds what is '
      'behind it', (tester) async {
    // A 360dp phone: the card's inside is just under 300dp there, which is
    // where the old layout stacked every button.
    tester.view.physicalSize = const Size(1080, 2376);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final makingOf = StubMakingOfRepository(
      MobileMakingOf(
        cast: [
          _castMember('voice-1', 'Neymar', 'Male lead'),
          _castMember('voice-2', 'The Waitress', 'Female lead'),
        ],
        chapters: const [
          MakingOfChapter(
            index: 1,
            title: 'The Table by the Window',
            summary: 'They meet over a late order.',
            firstPageIndex: 1,
          ),
          MakingOfChapter(
            index: 2,
            title: 'The Camera at the Door',
            summary: 'Phones come out.',
            firstPageIndex: 3,
          ),
        ],
        sources: [
          for (var i = 1; i <= 6; i++)
            MakingOfSource(
              title: 'Source $i',
              uri: Uri.parse('https://example.com/$i'),
              host: 'example.com',
            ),
        ],
        sourceCount: 7,
      ),
    );
    await pumpGenerationChat(
      tester,
      makingOf: makingOf,
      characters: LibraryOnlyCharactersRepository([
        LibraryCharacter(
          id: 'library-neymar',
          name: 'neymar',
          description: '',
          createdAt: DateTime.utc(2026, 10, 1),
          updatedAt: DateTime.utc(2026, 10, 1),
        ),
      ]),
      status: generationStatus(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
        currentAction: 'Ready to download.',
        planningDurationMs: 72000,
        bookGenerationDurationMs: 473000,
        exports: readyGenerationExports,
        generationProgress: const MobileGenerationProgress(
          percent: 100,
          steps: [
            MobileProjectStatusStep(
              key: 'prepare',
              label: 'Preparing your chapters',
              status: 'done',
              detail: '6 chapters',
            ),
            MobileProjectStatusStep(
              key: 'write',
              label: 'Writing your pages',
              status: 'done',
            ),
          ],
        ),
      ),
    );

    // The facts sit apart, so a line never breaks inside "made in 7m 53s";
    // a screen reader still hears them as one sentence.
    expect(find.text('made in 7m 53s'), findsOneWidget);
    expect(
      find.bySemanticsLabel(
        RegExp(r'Ready · 3 pages · 1 image · made in 7m 53s$'),
      ),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Read book'), findsOneWidget);
    // Everything beside Read book is quieter than it, and the stray progress
    // link is gone.
    expect(find.widgetWithText(FilledButton, 'Open PDF'), findsNothing);
    expect(find.widgetWithText(OutlinedButton, 'Open PDF'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Edit book'), findsOneWidget);
    // On a 360dp phone the two quieter actions share a row instead of
    // stacking under Read book.
    expect(
      tester.getTopLeft(find.widgetWithText(OutlinedButton, 'Open PDF')).dy,
      tester.getTopLeft(find.widgetWithText(OutlinedButton, 'Edit book')).dy,
    );
    expect(find.text('View progress'), findsNothing);

    // The job's steps only said again what the facts and the buttons say, so
    // they are gone; the folded row names what is behind it instead, once
    // its own read has answered (the card arrives on the last frame above).
    await settleEnough(tester);
    expect(makingOf.reads, ['project-1']);
    expect(find.text('See how it was made'), findsNothing);
    expect(find.text('Behind the book'), findsOneWidget);
    expect(
      find.bySemanticsLabel(
        'Behind the book. 2 characters · 2 chapters · 7 sources',
      ),
      findsOneWidget,
    );
    expect(find.text('Neymar'), findsNothing);

    await tester.ensureVisible(find.text('Behind the book'));
    await tester.pump();
    await tester.tap(find.text('Behind the book'));
    await settleEnough(tester);

    expect(find.text('Preparing your chapters'), findsNothing);
    expect(find.text('Neymar'), findsOneWidget);
    expect(find.text('The Waitress'), findsOneWidget);
    // Saved under the same name already: a door to it, not a second copy.
    expect(find.byKey(const ValueKey('behind-open-voice-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('behind-save-voice-1')), findsNothing);
    expect(find.byKey(const ValueKey('behind-save-voice-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('behind-call-voice-2')), findsOneWidget);
    expect(find.text('The Camera at the Door'), findsOneWidget);
    expect(find.text('Source 4'), findsOneWidget);
    expect(find.text('Source 5'), findsNothing);
    expect(find.text('Planned in 1m 12s, written in 7m 53s.'), findsOneWidget);

    await tester.ensureVisible(find.text('Show all 7'));
    await tester.pump();
    await tester.tap(find.text('Show all 7'));
    await settleEnough(tester);
    expect(find.text('Source 6'), findsOneWidget);
    expect(find.text('And 1 more.'), findsOneWidget);

    // A chapter is a door into the reader, at the page it opens on.
    await tester.ensureVisible(find.byKey(const ValueKey('behind-chapter-2')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('behind-chapter-2')));
    await settleEnough(tester);
    expect(find.text('Reader at page 3'), findsOneWidget);
  });

  testWidgets('saving a cast member opens the character editor with them '
      'already in it', (tester) async {
    tester.view.physicalSize = const Size(1080, 2376);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await pumpGenerationChat(
      tester,
      makingOf: StubMakingOfRepository(
        MobileMakingOf(
          cast: [_castMember('voice-2', 'The Waitress', 'Female lead')],
        ),
      ),
      status: generationStatus(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
        bookGenerationDurationMs: 473000,
        exports: readyGenerationExports,
      ),
    );
    await settleEnough(tester);
    await tester.ensureVisible(find.text('Behind the book'));
    await tester.pump();
    await tester.tap(find.text('Behind the book'));
    await settleEnough(tester);

    await tester.ensureVisible(
      find.byKey(const ValueKey('behind-save-voice-2')),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('behind-save-voice-2')));
    await settleEnough(tester);

    // Nothing is saved until the reader taps Save in the editor.
    Finder field(String text) => find.byWidgetPredicate(
      (widget) => widget is EditableText && widget.controller.text == text,
    );
    expect(find.text('New character'), findsOneWidget);
    expect(field('The Waitress'), findsOneWidget);
    expect(field('Female lead'), findsOneWidget);
  });

  testWidgets('a finished book with nothing behind it draws no empty row', (
    tester,
  ) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
        bookGenerationDurationMs: 473000,
        exports: readyGenerationExports,
      ),
    );
    await settleEnough(tester);

    expect(find.widgetWithText(FilledButton, 'Read book'), findsOneWidget);
    expect(find.text('Behind the book'), findsNothing);
  });

  testWidgets('a finished book with no file yet says so instead of going '
      'quiet', (tester) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'complete',
        statusLabel: 'Ready to export',
        progressPercent: 100,
      ),
    );

    expect(find.text('Your book file is being prepared.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Read book'), findsNothing);
  });

  testWidgets('a scheduled retry says when, and that nothing is asked of '
      'the reader', (tester) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'failed',
        failureMessage: 'A page timed out.',
        retryAvailable: true,
        nextRetryAt: DateTime.now().add(const Duration(minutes: 3)),
        retryState: 'scheduled',
        retryMessage: 'Picking your book back up in a moment.',
      ),
    );

    expect(
      find.text('Trying again in about 3 min. You don’t need to do anything.'),
      findsOneWidget,
    );
  });

  testWidgets('an API build without generationProgress still renders the '
      'compact bubble', (tester) async {
    await pumpGenerationChat(tester, status: generationStatus());

    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing your book pages.'), findsOneWidget);
    expect(find.text('3/28 pages'), findsOneWidget);
    expect(find.text('1 visual'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);
    // The client-side placeholder shapes the list; it never narrates.
    expect(find.text('Preparing your chapters'), findsOneWidget);
  });

  testWidgets('View progress opens the book page', (tester) async {
    await pumpGenerationChat(tester, status: generationStatus());

    // The always-present brief header shortens the transcript viewport, so
    // bring the button fully on-screen before tapping.
    await tester.ensureVisible(find.text('View progress'));
    await tester.pump();
    await tester.tap(find.text('View progress'));
    await settleEnough(tester);

    expect(find.text('Book route project-1'), findsOneWidget);
  });

  testWidgets('a failed book offers its retry in the chat, not one screen '
      'away', (tester) async {
    final projects = StubGenerationProjectsRepository(
      status: generationStatus(
        status: 'failed',
        statusLabel: 'Generation failed',
        currentAction: 'Writing stopped.',
        failureMessage: 'The writer stopped partway through.',
        retryAvailable: true,
      ),
    );
    await pumpGenerationChat(tester, projects: projects);

    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('The writer stopped partway through.'), findsOneWidget);

    // The price is said before the tap, in the card itself.
    expect(
      find.text(
        'A retry uses 40 credits, and they come back if it fails again.',
      ),
      findsOneWidget,
    );
    await tester.ensureVisible(find.text('Retry generation'));
    await tester.tap(find.text('Retry generation'));
    await settleEnough(tester);

    expect(find.textContaining('costs exactly 40 credits'), findsOneWidget);
    expect(find.textContaining('you have 100 available'), findsOneWidget);
    await tester.tap(find.text('Retry for 40'));
    await settleEnough(tester);

    expect(projects.resumedProjectIds, ['project-1']);
    // The book page is still there for anyone who wants it — the retry just no
    // longer lives only behind it.
    expect(find.text('Book route project-1'), findsNothing);
  });

  testWidgets('a balance that cannot be read stops the retry and says why', (
    tester,
  ) async {
    // The retry confirms its price against the balance. A billing read that
    // failed rethrew from outside any catch — or was disposed mid-retry — and
    // the button span for good.
    final billing = StubGenerationBillingRepository(failing: true);
    final projects = StubGenerationProjectsRepository(
      status: generationStatus(
        status: 'failed',
        statusLabel: 'Generation failed',
        currentAction: 'Writing stopped.',
        failureMessage: 'The writer stopped partway through.',
        retryAvailable: true,
      ),
    );
    await pumpGenerationChat(tester, projects: projects, billing: billing);

    await tester.ensureVisible(find.text('Retry generation'));
    await tester.tap(find.text('Retry generation'));
    await tester.pump();
    expect(find.text('Retrying generation'), findsOneWidget);

    // Bounded: Riverpod would retry a failing read for ~38 s.
    await tester.pump(const Duration(seconds: 16));
    await settleEnough(tester);

    expect(billing.calls, greaterThan(0));
    expect(
      find.text(
        "Couldn't check your credits. Check your connection and try again.",
      ),
      findsOneWidget,
    );
    expect(find.text('Retrying generation'), findsNothing);
    expect(projects.resumedProjectIds, isEmpty);

    // And the button works again: the balance is back, so the price is asked.
    billing.failing = false;
    await tester.pump(const Duration(seconds: 45));
    await tester.ensureVisible(find.text('Retry generation'));
    await tester.tap(find.text('Retry generation'));
    await settleEnough(tester);
    expect(find.textContaining('costs exactly 40 credits'), findsOneWidget);
  });

  testWidgets('a failure the server cannot resume offers no retry', (
    tester,
  ) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'failed',
        statusLabel: 'Generation failed',
        failureMessage: 'This book cannot be resumed.',
      ),
    );

    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('Retry generation'), findsNothing);
    expect(find.text('View progress'), findsOneWidget);
  });

  testWidgets('a scheduled automatic retry is not a failure and offers no '
      'second retry', (tester) async {
    await pumpGenerationChat(
      tester,
      status: generationStatus(
        status: 'failed',
        failureMessage: 'A page timed out.',
        retryAvailable: true,
        nextRetryAt: DateTime.utc(2026, 6, 15, 1),
        retryState: 'scheduled',
        retryMessage: 'Picking your book back up in a moment.',
      ),
    );

    expect(find.text('Retry scheduled'), findsOneWidget);
    expect(find.text('Picking your book back up in a moment.'), findsOneWidget);
    expect(find.text('Needs attention'), findsNothing);
    expect(find.text('Retry generation'), findsNothing);
  });

  // Rebuilding a finished book into a new one is a whole generation the chat
  // arrives at rather than starts, and it reports itself as an *edit*. Both of
  // those once left the footer frozen on a static list for the entire run.
  testWidgets('a book being rewritten shows the replan steps, not the '
      'placeholder plan list', (tester) async {
    await pumpGenerationChat(
      tester,
      projects: StubGenerationProjectsRepository(
        status: generationStatus(
          status: 'editing',
          statusLabel: 'Rewriting your book',
          progressPercent: 8,
          currentAction: 'Planning your new book',
          editProgress: const MobileGenerationProgress(
            percent: 8,
            detail: 'Planning your new book',
            steps: [
              MobileProjectStatusStep(
                key: 'revise',
                label: 'Planning your new book',
                status: 'active',
              ),
              MobileProjectStatusStep(
                key: 'save',
                label: 'Saving the new plan',
                status: 'pending',
              ),
              MobileProjectStatusStep(
                key: 'generate',
                label: 'Starting the rewrite',
                status: 'pending',
              ),
            ],
          ),
        ),
        detailBuilder: (_) => generationDetail(status: 'editing', plan: null),
      ),
    );
    // The status arrives a turn after the detail does, and the title and detail
    // lines crossfade — without this the outgoing text is still mounted.
    await settleEnough(tester);

    expect(find.text('Rewriting your book'), findsOneWidget);
    expect(find.text('Planning your new book'), findsWidgets);
    expect(find.text('Saving the new plan'), findsOneWidget);
    expect(find.text('Starting the rewrite'), findsOneWidget);
    expect(find.text('8%'), findsOneWidget);
    // The placeholder title and step the footer used to be stuck on.
    expect(find.text('Creating your book plan'), findsNothing);
    expect(find.text('Understanding your idea'), findsNothing);
  });

  testWidgets('the finished book is fetched when the status stream closes', (
    tester,
  ) async {
    final controller = StreamController<MobileProjectStatus>();
    addTearDown(controller.close);
    final projects = StubGenerationProjectsRepository(
      statusStream: controller.stream,
      // Still being rewritten when the screen arrives; finished by the time the
      // stream closes. Only a re-fetch can ever tell the screen the difference.
      detailBuilder: (call) => call == 0
          ? generationDetail(status: 'editing', plan: null)
          : generationDetail(status: 'complete'),
    );
    await pumpGenerationChat(tester, projects: projects);

    controller.add(
      generationStatus(status: 'editing', currentAction: 'Rewriting.'),
    );
    await settleEnough(tester);
    final fetchesWhileLive = projects.detailFetches;

    controller.add(generationStatus(status: 'complete', progressPercent: 100));
    await settleEnough(tester);

    expect(projects.detailFetches, greaterThan(fetchesWhileLive));
    expect(find.text('Rewriting your book'), findsNothing);
  });
}

/// The book the screen reads, at whatever stage a test needs it.

VoiceCharacter _castMember(String id, String name, String role) {
  return VoiceCharacter(
    id: id,
    projectId: 'project-1',
    name: name,
    role: role,
    description: '',
    traits: const [],
    status: VoiceCharacterStatus.ready,
    needsPreparation: true,
  );
}
