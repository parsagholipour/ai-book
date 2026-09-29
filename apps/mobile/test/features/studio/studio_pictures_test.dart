import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:tomeza/features/studio/domain/manuscript_models.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/media/photo_picker.dart';

import '../../support/fake_studio_repository.dart';
import 'studio_test_harness.dart';

const _text = 'The harbour was quiet. Boats slept.';

FakeStudioRepository _flow([String markdown = _text]) => FakeStudioRepository(
  chapters: [FakeStudioChapter(id: 'c1', title: 'Harbour', markdown: markdown)],
);

Future<void> _open(
  WidgetTester tester,
  FakeStudioRepository repo, {
  FakeStudioPhotoPicker? picker,
}) async {
  await tester.pumpWidget(studioTestApp(repo: repo, picker: picker));
  await settle(tester);
}

/// Puts the cursor at [offset] in the first text field and inserts a picture
/// from the photo library through the toolbar.
Future<void> _insertAt(WidgetTester tester, int offset) async {
  await tester.showKeyboard(bodyFields().first);
  tester.widget<EditableText>(bodyFields().first).controller.selection =
      TextSelection.collapsed(offset: offset);
  await tester.pump();
  await tester.tap(find.byTooltip('Picture'));
  await settle(tester);
  await tester.tap(find.text('Choose from photos'));
  await settle(tester);
}

void main() {
  testWidgets('a picture goes in at the cursor, splitting the text', (
    tester,
  ) async {
    final repo = _flow();
    final picker = FakeStudioPhotoPicker(result: fakePhoto());
    await _open(tester, repo, picker: picker);

    await _insertAt(tester, 22);
    expect(picker.calls.single, (
      source: ImageSource.gallery,
      purpose: PhotoPickerPurpose.bookImage,
    ));
    expect(repo.calls, contains('uploadImage:harbour.jpg'));
    expect(bodyFields(), findsNWidgets(2));
    expect(find.text('Add a caption'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 1300));
    expect(
      repo.saves.last.markdown,
      'The harbour was quiet.\n\n![](/assets/images/p1/upload-100.jpg)\n\n'
      'Boats slept.',
    );

    // The caption took focus; what is typed there is the picture's alt text.
    await tester.enterText(
      find.widgetWithText(TextField, 'Add a caption'),
      'The pier at dawn',
    );
    await tester.pump(const Duration(milliseconds: 1300));
    expect(
      repo.saves.last.markdown,
      contains('![The pier at dawn](/assets/images/p1/upload-100.jpg)'),
    );
    await closeStudio(tester);
  });

  testWidgets('undo in the first half never reaches back past the split', (
    tester,
  ) async {
    final repo = _flow();
    await _open(
      tester,
      repo,
      picker: FakeStudioPhotoPicker(result: fakePhoto()),
    );
    // Something typed before the split, so the field has history to undo.
    await tester.showKeyboard(bodyFields().first);
    await tester.enterText(bodyFields().first, '$_text Gulls cried.');
    await tester.pump(const Duration(milliseconds: 600));

    await _insertAt(tester, 22);
    expect(bodyFields(), findsNWidgets(2));
    final first = tester.widget<EditableText>(bodyFields().first);
    expect(first.controller.text, 'The harbour was quiet.');

    // Undo on the first half: the text that moved below the picture must not
    // come back above it too.
    await tester.showKeyboard(bodyFields().first);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyZ);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump(const Duration(milliseconds: 1300));
    final saved = repo.saves.last.markdown;
    expect(RegExp('Boats slept').allMatches(saved).length, 1, reason: saved);
    expect(RegExp('Gulls cried').allMatches(saved).length, 1, reason: saved);
    await closeStudio(tester);
  });

  testWidgets('the upload shows its progress in place', (tester) async {
    final repo = _HeldUploads();
    await _open(tester, repo);
    await _insertAt(tester, _text.length);
    expect(find.text('Adding your picture… 40%'), findsOneWidget);
    // Nothing is saved for a picture that has not landed.
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.every((save) => !save.markdown.contains('![')), isTrue);

    repo.finish();
    await settle(tester);
    expect(find.textContaining('Adding your picture'), findsNothing);
    expect(find.text('Add a caption'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.last.markdown, '$_text\n\n![](/held.jpg)');
    await closeStudio(tester);
  });

  testWidgets('a failed upload closes the split and says so', (tester) async {
    final repo = _flow()
      ..uploadError = const ApiException(
        code: 'NETWORK_ERROR',
        message: 'No connection.',
      );
    await _open(tester, repo);
    await _insertAt(tester, 22);
    expect(bodyFields(), findsOneWidget);
    expect(
      tester.widget<EditableText>(bodyFields().first).controller.text,
      _text,
    );
    expect(
      find.text(
        'The picture didn’t upload. Check your connection and try again.',
      ),
      findsOneWidget,
    );
    await closeStudio(tester);
  });

  testWidgets('a picture moves by paragraph and can be removed', (
    tester,
  ) async {
    final repo = _flow('One.\n\nTwo.\n\n![Pier](/a.jpg)\n\nThree.');
    await _open(tester, repo);

    await tester.tap(find.byTooltip('Picture options'));
    await settle(tester);
    await tester.tap(find.text('Move up'));
    await settle(tester);
    await tester.pump(const Duration(milliseconds: 1300));
    expect(
      repo.saves.last.markdown,
      'One.\n\n![Pier](/a.jpg)\n\nTwo.\n\nThree.',
    );

    await tester.tap(find.byTooltip('Picture options'));
    await settle(tester);
    await tester.tap(find.text('Remove picture'));
    await settle(tester);
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.last.markdown, 'One.\n\nTwo.\n\nThree.');
    expect(bodyFields(), findsOneWidget);
    await closeStudio(tester);
  });

  testWidgets('a chart is shown as a card and left alone', (tester) async {
    const chart = '```figure\n{"kind":"bar","title":"Catch by year"}\n```';
    final repo = _flow('Before.\n\n$chart\n\nAfter.');
    await _open(tester, repo);
    expect(find.text('Bar chart · Catch by year'), findsOneWidget);
    await tester.enterText(bodyFields().last, 'After, edited.');
    await tester.pump(const Duration(milliseconds: 1300));
    expect(repo.saves.last.markdown, 'Before.\n\n$chart\n\nAfter, edited.');
    await closeStudio(tester);
  });

  group('picture book', () {
    FakeStudioRepository book() => FakeStudioRepository(
      layout: ManuscriptLayout.picture,
      kind: ManuscriptKind.picture,
      chapters: [
        FakeStudioChapter(
          id: 'c1',
          title: 'Pip Finds the Moon',
          markdown:
              '![Pip](/1.jpg)\n\nPip could not sleep.\n\n<!-- page -->\n\n'
              'So she put on her boots.',
        ),
      ],
    );

    testWidgets('pages are cards; a page can be added', (tester) async {
      final repo = book();
      await _open(tester, repo);
      expect(find.text('Page 1'), findsOneWidget);
      expect(find.text('Page 2'), findsOneWidget);
      expect(find.text('Add a picture'), findsOneWidget);

      await tester.ensureVisible(find.byKey(const ValueKey('studio-add-page')));
      await tester.tap(find.byKey(const ValueKey('studio-add-page')));
      await settle(tester);
      expect(find.text('Page 3'), findsOneWidget);
      await tester.enterText(bodyFields().last, 'The moon smiled.');
      await tester.pump(const Duration(milliseconds: 1300));
      expect(
        repo.saves.last.markdown,
        endsWith(
          'So she put on her boots.\n\n<!-- page -->\n\nThe moon smiled.',
        ),
      );
      await closeStudio(tester);
    });

    testWidgets('a deleted page comes back with Undo', (tester) async {
      final repo = book();
      await _open(tester, repo);
      await tester.tap(find.byTooltip('Page 1 options'));
      await settle(tester);
      await tester.tap(find.text('Delete page'));
      await settle(tester);
      expect(find.text('Page 2'), findsNothing);
      expect(find.text('Page 1 deleted'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1300));
      expect(repo.saves.last.markdown, 'So she put on her boots.');

      await tester.tap(find.text('Undo'));
      await settle(tester);
      expect(find.text('Page 2'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1300));
      expect(
        repo.saves.last.markdown,
        '![Pip](/1.jpg)\n\nPip could not sleep.\n\n<!-- page -->\n\n'
        'So she put on her boots.',
      );
      await closeStudio(tester);
    });

    testWidgets('pages move, and an empty slot takes a picture', (
      tester,
    ) async {
      final repo = book();
      await _open(tester, repo);
      await tester.tap(find.byTooltip('Page 2 options'));
      await settle(tester);
      await tester.tap(find.text('Move up'));
      await settle(tester);

      await tester.tap(find.text('Add a picture'));
      await settle(tester);
      await tester.tap(find.text('Choose from photos'));
      await settle(tester);
      await tester.pump(const Duration(milliseconds: 1300));
      expect(
        repo.saves.last.markdown,
        '![](/assets/images/p1/upload-100.jpg)\n\nSo she put on her boots.'
        '\n\n<!-- page -->\n\n![Pip](/1.jpg)\n\nPip could not sleep.',
      );
      await closeStudio(tester);
    });
  });
}

/// Holds every upload at 40% until [finish].
class _HeldUploads extends FakeStudioRepository {
  _HeldUploads()
    : super(
        chapters: [
          FakeStudioChapter(id: 'c1', title: 'Harbour', markdown: _text),
        ],
      );

  final _pending = Completer<ManuscriptUploadedImage>();

  void finish() => _pending.complete(
    const ManuscriptUploadedImage(url: '/held.jpg', width: 10, height: 10),
  );

  @override
  Future<ManuscriptUploadedImage> uploadImage({
    required String projectId,
    required List<int> bytes,
    required String filename,
    required String contentType,
    void Function(int sent, int total)? onProgress,
  }) {
    onProgress?.call(40, 100);
    return _pending.future;
  }
}
