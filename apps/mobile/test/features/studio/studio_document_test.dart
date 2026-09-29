import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';

StudioDocument _doc(
  String markdown, {
  bool picture = false,
  void Function()? onEdited,
}) {
  return StudioDocument(
    title: 'Chapter',
    markdown: markdown,
    picture: picture,
    onEdited: onEdited ?? () {},
    onFocusChanged: (_) {},
  );
}

final _bytes = Uint8List.fromList([1, 2, 3]);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('opens and saves a chapter byte for byte', () {
    const markdown =
        'One.\n\n![a](/a.jpg)\n\n```figure\n{"kind":"bar"}\n```\n\nTwo.';
    final doc = _doc(markdown);
    expect(doc.markdown, markdown);
    // Somewhere to type before the first picture and after the last block.
    expect(doc.entries.first, isA<StudioTextEntry>());
    expect(doc.entries.last, isA<StudioTextEntry>());
  });

  test('two pictures in a row get a place to type between them', () {
    final doc = _doc('![a](/a.jpg)\n\n![b](/b.jpg)');
    expect(doc.entries.map((e) => e.runtimeType), [
      StudioTextEntry,
      StudioImageEntry,
      StudioTextEntry,
      StudioImageEntry,
      StudioTextEntry,
    ]);
    expect(doc.markdown, '![a](/a.jpg)\n\n![b](/b.jpg)');
  });

  group('pictures in a flow chapter', () {
    test('an insert splits the text at the cursor', () {
      final doc = _doc('The harbour was quiet. Boats slept.');
      final text = doc.textEntries.single;
      final upload = doc.insertUpload(_bytes, target: text, offset: 22);
      expect(doc.entries.map((e) => e.runtimeType), [
        StudioTextEntry,
        StudioUploadEntry,
        StudioTextEntry,
      ]);
      // Nothing is saved for the picture until it has landed.
      expect(doc.markdown, 'The harbour was quiet.\n\nBoats slept.');

      doc.completeUpload(upload, '/assets/images/p1/upload-1.jpg');
      expect(
        doc.markdown,
        'The harbour was quiet.\n\n![](/assets/images/p1/upload-1.jpg)\n\n'
        'Boats slept.',
      );
    });

    test('a failed upload puts the sentence back exactly', () {
      final doc = _doc('The harbour was quiet. Boats slept.');
      final upload = doc.insertUpload(
        _bytes,
        target: doc.textEntries.single,
        offset: 22,
      );
      doc.cancelUpload(upload);
      expect(doc.markdown, 'The harbour was quiet. Boats slept.');
      expect(doc.entries, hasLength(1));
    });

    test('with no cursor the picture goes at the end', () {
      final doc = _doc('Only text.');
      final upload = doc.insertUpload(_bytes);
      doc.completeUpload(upload, '/x.jpg');
      expect(doc.markdown, 'Only text.\n\n![](/x.jpg)');
    });

    test('removing a picture joins the text around it', () {
      final doc = _doc('Above.\n\n![a](/a.jpg)\n\nBelow.');
      doc.removeEntry(doc.entries.whereType<StudioImageEntry>().single);
      expect(doc.markdown, 'Above.\n\nBelow.');
      expect(doc.textEntries, hasLength(1));
    });

    test('moving a picture steps over one paragraph at a time', () {
      final doc = _doc('P1\n\nP2\n\n![a](/a.jpg)\n\nP3');
      final image = doc.entries.whereType<StudioImageEntry>().single;
      doc.moveEntry(image, up: true);
      expect(doc.markdown, 'P1\n\n![a](/a.jpg)\n\nP2\n\nP3');
      doc.moveEntry(image, up: true);
      expect(doc.markdown, '![a](/a.jpg)\n\nP1\n\nP2\n\nP3');
      expect(doc.canMoveUp(image), isFalse);
      doc.moveEntry(image, up: false);
      doc.moveEntry(image, up: false);
      doc.moveEntry(image, up: false);
      expect(doc.markdown, 'P1\n\nP2\n\nP3\n\n![a](/a.jpg)');
      expect(doc.canMoveDown(image), isFalse);
    });

    test('a picture next to a picture trades places with it', () {
      final doc = _doc('![a](/a.jpg)\n\n![b](/b.jpg)');
      final b = doc.entries.whereType<StudioImageEntry>().last;
      doc.moveEntry(b, up: true);
      expect(doc.markdown, '![b](/b.jpg)\n\n![a](/a.jpg)');
    });

    test('a replaced picture keeps its caption, or comes back', () {
      final doc = _doc('![Lamp](/old.jpg)');
      final image = doc.entries.whereType<StudioImageEntry>().single;
      final failed = doc.beginReplace(image, _bytes);
      doc.cancelUpload(failed);
      expect(doc.markdown, '![Lamp](/old.jpg)');

      final upload = doc.beginReplace(image, _bytes);
      doc.completeUpload(upload, '/new.jpg');
      expect(doc.markdown, '![Lamp](/new.jpg)');
    });

    test('a caption edit is saved and reported', () {
      var edits = 0;
      final doc = _doc('![](/a.jpg)', onEdited: () => edits++);
      doc.entries.whereType<StudioImageEntry>().single.caption.text =
          'The lighthouse';
      expect(doc.markdown, '![The lighthouse](/a.jpg)');
      expect(edits, 1);
    });
  });

  group('picture book pages', () {
    const book =
        '![p1](/1.jpg)\n\nOnce upon a time.\n\n<!-- page -->\n\nThe end.';

    test('every page has a picture slot and a text field', () {
      final doc = _doc(book, picture: true);
      final pages = doc.pages;
      expect(pages, hasLength(2));
      expect(pages[0].picture, isA<StudioImageEntry>());
      expect(pages[0].firstText!.text, 'Once upon a time.');
      expect(pages[1].picture, isNull);
      expect(pages[1].firstText!.text, 'The end.');
      expect(doc.markdown, book);
    });

    test('a page picture goes into the slot', () {
      final doc = _doc(book, picture: true);
      final upload = doc.insertPagePictureUpload(1, _bytes);
      expect(doc.pages[1].picture, same(upload));
      doc.completeUpload(upload, '/2.jpg');
      expect(
        doc.markdown,
        '![p1](/1.jpg)\n\nOnce upon a time.\n\n<!-- page -->\n\n![](/2.jpg)\n\n'
        'The end.',
      );
    });

    test('pages are added, moved, deleted and restored', () {
      final doc = _doc(book, picture: true);
      final added = doc.addPage();
      added.setText('Epilogue.');
      expect(doc.pages, hasLength(3));
      expect(doc.markdown, '$book\n\n<!-- page -->\n\nEpilogue.');

      doc.movePage(2, up: true);
      expect(
        doc.markdown,
        '![p1](/1.jpg)\n\nOnce upon a time.\n\n<!-- page -->\n\nEpilogue.\n\n'
        '<!-- page -->\n\nThe end.',
      );

      final removed = doc.deletePage(0);
      expect(doc.markdown, 'Epilogue.\n\n<!-- page -->\n\nThe end.');
      doc.restorePage(0, removed);
      expect(
        doc.markdown,
        '![p1](/1.jpg)\n\nOnce upon a time.\n\n<!-- page -->\n\nEpilogue.\n\n'
        '<!-- page -->\n\nThe end.',
      );
    });

    test('deleting the only page leaves an empty one', () {
      final doc = _doc('Just one page.', picture: true);
      doc.deletePage(0);
      expect(doc.pages, hasLength(1));
      expect(doc.markdown, '');
    });
  });

  test('replacing the content swaps every entry and reports an edit', () {
    var edits = 0;
    final doc = _doc('Old text.', onEdited: () => edits++);
    doc.replaceContent(title: 'Restored', markdown: 'New.\n\n![a](/a.jpg)');
    expect(doc.title.text, 'Restored');
    expect(doc.markdown, 'New.\n\n![a](/a.jpg)');
    expect(edits, greaterThan(0));
  });

  test('words are counted per segment as they change', () {
    final doc = _doc('One two three.\n\n![caption words](/a.jpg)\n\nFour.');
    expect(doc.words, 4);
    doc.textEntries.last.setText('Four five six.');
    expect(doc.words, 6);
  });
}
