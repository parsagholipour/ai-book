import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/sharing/data/book_share_repository.dart';
import 'package:tomeza/features/sharing/domain/book_share_models.dart';
import 'package:tomeza/features/sharing/presentation/book_share_form.dart';
import 'package:tomeza/features/sharing/presentation/book_share_progress.dart';
import 'package:tomeza/features/sharing/presentation/book_share_sheet.dart';
import 'package:tomeza/shared/api/api_error.dart';

import '../../projects/book_page_fixtures.dart';
import 'fake_book_share_repository.dart';

// The book's share sheet, in each state a share can be in.

MobileBilling _billing(int available) => MobileBilling(
  credits: CreditBalance(
    available: available,
    reserved: 0,
    lifetimeGranted: available,
    lifetimeSpent: 0,
  ),
  entitlements: const [],
  products: const [],
  creditCosts: const {},
);

class _Sheet {
  _Sheet(this.repo, {this.available = 1000});

  final FakeBookShareRepository repo;
  final int available;

  /// Links handed to the system share sheet.
  final shared = <String>[];

  Future<void> open(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          bookShareRepositoryProvider.overrideWithValue(repo),
          billingProvider.overrideWith((ref) async => _billing(available)),
          shareLinkSenderProvider.overrideWithValue((url, {subject}) async {
            shared.add(url);
          }),
        ],
        child: MaterialApp(
          theme: buildTomezaLightTheme(),
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () => showBookShareSheet(
                    context,
                    projectId: 'project-1',
                    bookTitle: 'The Lighthouse Letter',
                  ),
                  child: const Text('Open share'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open share'));
    await settle(tester);
  }
}

/// Frames in 100 ms steps: the saving button's sparkle never settles.
Future<void> settle(
  WidgetTester tester, [
  Duration duration = const Duration(milliseconds: 800),
]) async {
  for (var i = 0; i < duration.inMilliseconds ~/ 100; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.tap(find.text(text));
  await settle(tester);
}

Finder inDialog(String text) =>
    find.descendant(of: find.byType(AlertDialog), matching: find.text(text));

void main() {
  testWidgets('the finished book’s own page opens its share sheet', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(500, 2600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repo = FakeBookShareRepository();
    await tester.pumpWidget(
      bookPageApp(
        visited: [],
        project: bookProject(),
        status: bookStatus(),
        overrides: [bookShareRepositoryProvider.overrideWithValue(repo)],
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Share'));
    await settle(tester);

    expect(find.text('Share your book'), findsOneWidget);
    expect(find.text('Share preview'), findsOneWidget);
  });

  testWidgets('a book not shared yet offers a free preview and needs the '
      'rights confirmed before it shares', (tester) async {
    final repo = FakeBookShareRepository();
    final sheet = _Sheet(repo);
    await sheet.open(tester);

    expect(find.text('Share preview'), findsOneWidget);
    expect(find.textContaining('Previews are free'), findsOneWidget);
    // The cap is half of 24; the first preview offers ten of them.
    expect(find.text('10 of 24 printed pages'), findsOneWidget);
    expect(find.text(BookShareForm.rightsLabel), findsOneWidget);
    expect(find.text(BookShareForm.likenessLabel), findsNothing);
    expect(find.text('0/500'), findsOneWidget);

    await tapText(tester, 'Share preview');
    expect(repo.saves, isEmpty);
    expect(
      find.text('Confirm the statement above to share your book.'),
      findsOneWidget,
    );

    for (var i = 0; i < 3; i++) {
      await tester.tap(find.byTooltip('More pages'));
      await tester.pump();
    }
    // Twelve is the cap: the third tap is refused.
    expect(find.text('12 of 24 printed pages'), findsOneWidget);

    await tapText(tester, BookShareForm.rightsLabel);
    repo.saveGate = Completer<void>();
    await tester.ensureVisible(find.text('Share preview'));
    await tester.tap(find.text('Share preview'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // A real processing state, not a spinner: the paced button names the step.
    expect(find.byKey(const ValueKey('book-share-saving')), findsOneWidget);
    expect(find.text('Checking your book…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    repo.saveGate!.complete();
    await settle(tester);

    final request = repo.saves.single;
    expect(request.mode, BookShareMode.preview);
    expect(request.previewPages, 12);
    expect(request.rightsConfirmed, isTrue);
    expect(request.toJson().containsKey('acceptExportUnlock'), isFalse);
    expect(request.toJson()['caption'], isNull);

    expect(
      find.text('Shared · Preview 12 of 24 printed pages'),
      findsOneWidget,
    );
    // A new link goes straight to the system share sheet.
    expect(sheet.shared, [shareUrl]);
  });

  testWidgets('a live preview shows its state, copies its link, and stops', (
    tester,
  ) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(),
        share: bookShare(previewPages: 6, caption: 'For night readers.'),
      ),
    );
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await _Sheet(repo).open(tester);

    expect(find.text('Shared · Preview 6 of 24 printed pages'), findsOneWidget);
    expect(find.text(shareUrl), findsOneWidget);
    expect(find.text('3 views · shown without your name'), findsOneWidget);
    expect(find.text('For night readers.'), findsOneWidget);
    expect(find.text('Note under review'), findsNothing);
    expect(find.text('Share link'), findsOneWidget);
    expect(find.text('Edit'), findsOneWidget);

    await tapText(tester, 'Copy link');
    expect(copied, shareUrl);
    expect(find.text('Copied'), findsOneWidget);
    await settle(tester, const Duration(seconds: 3));
    expect(find.text('Copy link'), findsOneWidget);

    await tapText(tester, 'Stop sharing');
    expect(find.text('Stop sharing this book?'), findsOneWidget);
    await tester.tap(inDialog('Stop sharing'));
    await settle(tester);

    expect(repo.stops, 1);
    expect(find.text('Sharing stopped. The link no longer works.'), findsOne);
    // The old settings are offered back, ready to share again.
    expect(find.text('6 of 24 printed pages'), findsOneWidget);
    expect(find.text('Share preview'), findsOneWidget);
  });

  testWidgets('Edit changes a live share without asking for the rights again', (
    tester,
  ) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(book: shareBook(), share: bookShare()),
    );
    final sheet = _Sheet(repo);
    await sheet.open(tester);

    await tapText(tester, 'Edit');
    expect(find.text(BookShareForm.rightsLabel), findsNothing);
    await tester.tap(find.byTooltip('Fewer pages'));
    await tester.pump();
    expect(find.text('5 of 24 printed pages'), findsOneWidget);

    await tapText(tester, 'Save changes');
    expect(repo.saves.single.previewPages, 5);
    expect(find.text('Shared · Preview 5 of 24 printed pages'), findsOneWidget);
    // Only a new link opens the system share sheet.
    expect(sheet.shared, isEmpty);
  });

  testWidgets('a full share is free: no price, no question, no unlock sent', (
    tester,
  ) async {
    // A balance under the old unlock price changes nothing: the full share
    // used to charge the book's export unlock, and that unlock is gone.
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(book: shareBook()),
    );
    await _Sheet(repo, available: 40).open(tester);

    await tapText(tester, 'Full book');
    expect(
      find.text(
        'Readers can read the whole book. Sharing it in full is '
        'free.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('credits'), findsNothing);
    expect(find.textContaining('nlock'), findsNothing);
    expect(find.text('Get credits'), findsNothing);
    expect(find.text('Share full book'), findsOneWidget);

    await tapText(tester, BookShareForm.rightsLabel);
    await tapText(tester, 'Share full book');
    expect(find.byType(AlertDialog), findsNothing);

    final request = repo.saves.single;
    expect(request.mode, BookShareMode.full);
    expect(request.toJson().containsKey('previewPages'), isFalse);
    expect(request.toJson().containsKey('acceptExportUnlock'), isFalse);
    expect(find.text('Shared · Full book'), findsOneWidget);
  });

  testWidgets('a note held for review says so, in exactly those words', (
    tester,
  ) async {
    final repo = FakeBookShareRepository()
      ..captionVerdict = BookShareCaptionStatus.pendingReview;
    await _Sheet(repo).open(tester);

    await tester.enterText(
      find.byKey(const ValueKey('book-share-caption')),
      'A bedtime story about a brave lighthouse cat.',
    );
    await tester.pump();
    expect(find.text('45/500'), findsOneWidget);
    await tapText(tester, BookShareForm.rightsLabel);

    repo.saveGate = Completer<void>();
    await tester.ensureVisible(find.text('Share preview'));
    await tester.tap(find.text('Share preview'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Checking your book…'), findsOneWidget);
    // The note is the slow part, and the button says when it has got there.
    await tester.pump(const Duration(milliseconds: 2500));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Checking your note…'), findsOneWidget);

    repo.saveGate!.complete();
    await settle(tester);

    expect(
      repo.saves.single.caption,
      'A bedtime story about a brave lighthouse cat.',
    );
    expect(find.text(bookShareNoteHeldNotice), findsOneWidget);
    expect(
      bookShareNoteHeldNotice,
      'Your book is shared; your note is waiting for review.',
    );
    expect(find.text('Note under review'), findsOneWidget);
  });

  testWidgets('a refused note is explained under the note, verbatim', (
    tester,
  ) async {
    const refusal =
        'This note includes someone’s personal details, like a phone number '
        'or an address, which can’t be shown on a public page. Edit it and '
        'try again.';
    final repo = FakeBookShareRepository()
      ..saveError = const ApiException(
        code: 'CAPTION_PERSONAL_INFO',
        message: refusal,
        statusCode: 422,
      );
    await _Sheet(repo).open(tester);

    await tester.enterText(
      find.byKey(const ValueKey('book-share-caption')),
      'Call me on 555 0100',
    );
    await tapText(tester, BookShareForm.rightsLabel);
    await tapText(tester, 'Share preview');

    expect(find.text(refusal), findsOneWidget);
    // Still the settings, with the note as written, ready to edit.
    expect(find.text('Share preview'), findsOneWidget);
    expect(find.text('Call me on 555 0100'), findsOneWidget);
  });

  testWidgets('a book the text screen refuses says so above the button', (
    tester,
  ) async {
    final repo = FakeBookShareRepository()
      ..saveError = const ApiException(
        code: 'CONTENT_RESTRICTED',
        message: 'This book contains content that can’t be shared publicly.',
        statusCode: 422,
      );
    await _Sheet(repo).open(tester);

    await tapText(tester, BookShareForm.rightsLabel);
    await tapText(tester, 'Share preview');

    expect(find.text('This book can’t be shared publicly'), findsOneWidget);
    expect(
      find.text('This book contains content that can’t be shared publicly.'),
      findsOneWidget,
    );
  });

  testWidgets('a link the system turned off says why, and shares again as '
      'usual', (tester) async {
    const reason =
        'This link was turned off because your latest changes didn\'t pass '
        'our content check. Edit the book and share it again.';
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(),
        share: bookShare(
          status: BookShareStatus.revoked,
          previewPages: 6,
          stoppedReason: reason,
        ),
      ),
    );
    await _Sheet(repo).open(tester);

    // The form, with the old settings and the server's sentence in the
    // notice slot — not the generic line, and not the taken-down view.
    expect(find.text(reason), findsOneWidget);
    expect(
      find.text('Sharing stopped. The link no longer works.'),
      findsNothing,
    );
    expect(find.text('6 of 24 printed pages'), findsOneWidget);
    expect(find.textContaining('moderator'), findsNothing);

    // Text that still fails is refused like any new share, and the reason
    // stays beside it.
    repo.saveError = const ApiException(
      code: 'CONTENT_RESTRICTED',
      message: 'This book contains content that can’t be shared publicly.',
      statusCode: 422,
    );
    await tapText(tester, BookShareForm.rightsLabel);
    await tapText(tester, 'Share preview');
    expect(find.text('This book can’t be shared publicly'), findsOneWidget);
    expect(find.text(reason), findsOneWidget);

    // Fixed text shares again: a live link, and the reason is gone.
    await tapText(tester, 'Share preview');
    expect(repo.saves.last.rightsConfirmed, isTrue);
    expect(find.text('Shared · Preview 6 of 24 printed pages'), findsOneWidget);
    expect(find.text(reason), findsNothing);
  });

  test('stoppedReason is read only when the server sends one', () {
    Map<String, dynamic> wire(Object? reason) => {
      'slug': shareSlug,
      'url': shareUrl,
      'mode': 'preview',
      'status': 'revoked',
      'previewPages': 6,
      'stoppedReason': reason,
    };
    expect(
      BookShare.fromJson(wire('Turned off.')).stoppedReason,
      'Turned off.',
    );
    expect(BookShare.fromJson(wire(null)).stoppedReason, isNull);
    expect(BookShare.fromJson(wire('  ')).stoppedReason, isNull);
    expect(
      BookShare.fromJson(wire(null)..remove('stoppedReason')).stoppedReason,
      isNull,
    );
  });

  testWidgets('a taken-down share gives the reason and offers nothing to '
      'change', (tester) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(),
        share: bookShare(
          status: BookShareStatus.takenDown,
          takedownReason: 'It reproduces a published novel.',
        ),
      ),
    );
    await _Sheet(repo).open(tester);

    expect(
      find.text('Taken down: It reproduces a published novel.'),
      findsOneWidget,
    );
    expect(find.textContaining('can’t be shared again'), findsOneWidget);
    expect(find.text('Share preview'), findsNothing);
    expect(find.text('Edit'), findsNothing);
    expect(find.text('Share link'), findsNothing);
  });

  testWidgets('a book drawn from a real photo asks for that too', (
    tester,
  ) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(book: shareBook(likenessRequired: true)),
    );
    await _Sheet(repo).open(tester);

    expect(
      find.text(
        'This book features someone drawn from a real photo. Anyone with the '
        'link can see it.',
      ),
      findsOneWidget,
    );

    await tapText(tester, BookShareForm.rightsLabel);
    await tapText(tester, 'Share preview');
    expect(repo.saves, isEmpty);
    expect(
      find.text('Confirm both statements to share your book.'),
      findsOneWidget,
    );

    await tapText(tester, BookShareForm.likenessLabel);
    await tapText(tester, 'Share preview');
    expect(repo.saves.single.likenessConfirmed, isTrue);
    expect(repo.saves.single.rightsConfirmed, isTrue);
  });

  testWidgets('editing a live share without the likeness on record asks '
      'for it, and only for it', (tester) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(likenessRequired: true),
        share: bookShare(likenessConfirmed: false),
      ),
    );
    await _Sheet(repo).open(tester);

    await tapText(tester, 'Edit');
    expect(find.text(BookShareForm.likenessLabel), findsOneWidget);
    expect(find.text(BookShareForm.rightsLabel), findsNothing);

    await tapText(tester, 'Save changes');
    expect(repo.saves, isEmpty);
    expect(
      find.text('Confirm the statement above to share your book.'),
      findsOneWidget,
    );

    await tapText(tester, BookShareForm.likenessLabel);
    await tapText(tester, 'Save changes');
    expect(repo.saves.single.likenessConfirmed, isTrue);
    expect(repo.saves.single.rightsConfirmed, isFalse);
    expect(find.text('Shared · Preview 6 of 24 printed pages'), findsOneWidget);
  });

  testWidgets('editing a live share with the likeness on record asks for '
      'neither confirmation', (tester) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(likenessRequired: true),
        share: bookShare(likenessConfirmed: true),
      ),
    );
    await _Sheet(repo).open(tester);

    await tapText(tester, 'Edit');
    expect(find.text(BookShareForm.likenessLabel), findsNothing);
    expect(find.text(BookShareForm.rightsLabel), findsNothing);

    await tapText(tester, 'Save changes');
    expect(repo.saves.single.likenessConfirmed, isFalse);
    expect(find.text('Shared · Preview 6 of 24 printed pages'), findsOneWidget);
  });

  testWidgets('a likeness the server says is missing is asked for after all', (
    tester,
  ) async {
    final repo =
        FakeBookShareRepository(
            snapshot: BookShareSnapshot(
              book: shareBook(likenessRequired: true),
              share: bookShare(likenessConfirmed: true),
            ),
          )
          ..saveError = const ApiException(
            code: 'SHARE_LIKENESS_REQUIRED',
            message:
                'This book features someone drawn from a real photo. Confirm '
                'that anyone with the link can see it.',
            statusCode: 400,
          );
    await _Sheet(repo).open(tester);

    await tapText(tester, 'Edit');
    await tapText(tester, 'Save changes');
    expect(find.text(BookShareForm.likenessLabel), findsOneWidget);

    await tapText(tester, BookShareForm.likenessLabel);
    await tapText(tester, 'Save changes');
    expect(repo.saves.last.likenessConfirmed, isTrue);
    expect(find.text('Shared · Preview 6 of 24 printed pages'), findsOneWidget);
  });

  testWidgets('a book that is not finished explains why it cannot be shared', (
    tester,
  ) async {
    final repo = FakeBookShareRepository(
      snapshot: BookShareSnapshot(
        book: shareBook(
          shareable: false,
          unavailableReason: BookShareUnavailableReason.notFinished,
        ),
      ),
    );
    await _Sheet(repo).open(tester);

    expect(find.text('Not ready to share yet'), findsOneWidget);
    expect(find.text('Share preview'), findsNothing);
  });

  test('the stages a save paces through never claim a step it is not on', () {
    expect(
      bookShareSavingStages(
        creating: true,
        checkingBook: true,
        checkingNote: true,
      ),
      [
        'Checking your book…',
        'Checking your note…',
        'Still checking your note…',
      ],
    );
    expect(
      bookShareSavingStages(
        creating: true,
        checkingBook: true,
        checkingNote: false,
      ),
      ['Checking your book…', 'Creating your link…'],
    );
    expect(
      bookShareSavingStages(
        creating: false,
        checkingBook: false,
        checkingNote: false,
      ),
      ['Saving your changes…'],
    );
    // The last line is the one a slow save settles on.
    expect(bookShareStageAt(const Duration(minutes: 1), ['a', 'b']), 'b');
    expect(
      pacedBookShareProgress(const Duration(minutes: 5), slow: true),
      lessThan(1),
    );
  });
}
