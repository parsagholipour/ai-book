import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_link.dart';
import 'package:tomeza/features/reader/presentation/reader_links.dart';

/// An A4 page the size Chrome prints the book at, with nothing loaded behind
/// it. Only the geometry is ever read.
///
/// [width] and [height] are the *displayed* extents, which is what pdfrx
/// reports: a quarter-turned A4 page is 842 by 595.
class _FakePage implements PdfPage {
  _FakePage({
    this.width = 595,
    this.height = 842,
    this.rotation = PdfPageRotation.none,
  });

  @override
  final double width;

  @override
  final double height;

  @override
  final PdfPageRotation rotation;

  @override
  bool get isLoaded => true;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A citation on the Sources page: one line of type, a third of the way down.
const _sourceRect = PdfRect(72, 700, 300, 686);

PdfLink _urlLink(String url, {PdfRect rect = _sourceRect}) =>
    PdfLink([rect], url: Uri.parse(url));

void main() {
  group('readerLinkUrl', () {
    test('opens the web and nothing else', () {
      for (final url in [
        'https://example.org/salt-sahara?ref=book#p12',
        'http://example.org',
        'https://example.org:8443/path',
      ]) {
        expect(readerLinkUrl(Uri.parse(url)), Uri.parse(url), reason: url);
      }
    });

    test('refuses every scheme that is not the web', () {
      for (final url in [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'intent://scan/#Intent;scheme=zxing;end',
        'market://details?id=com.example',
        'tel:+15551234567',
        'sms:+15551234567',
        'mailto:someone@example.org',
        'data:text/html,<h1>hi</h1>',
        'tomeza://projects/1',
      ]) {
        expect(readerLinkUrl(Uri.parse(url)), isNull, reason: url);
      }
    });

    test('refuses a host that is not what the reader would read', () {
      // Reads as Wikipedia, goes to evil.example — and the page prints only
      // the citation's title, so there is nothing to read it off.
      expect(
        readerLinkUrl(Uri.parse('https://en.wikipedia.org@evil.example/a')),
        isNull,
      );
      expect(readerLinkUrl(Uri.parse('https:///path')), isNull);
      expect(readerLinkUrl(null), isNull);
    });
  });

  group('readerPageLinks', () {
    test('turns PDF geometry into the reader\'s own', () {
      final links = readerPageLinks([
        _urlLink('https://example.org/a'),
      ], _FakePage());

      expect(links, hasLength(1));
      final rect = links.single.rects.single;
      // PDF coordinates count up from the bottom of the page; the reader's
      // count down from the top.
      expect(rect.left, closeTo(72 / 595, 1e-9));
      expect(rect.top, closeTo((842 - 700) / 842, 1e-9));
      expect(rect.width, closeTo((300 - 72) / 595, 1e-9));
      expect(rect.height, closeTo((700 - 686) / 842, 1e-9));
    });

    test('follows the page round when the page is turned', () {
      // Nothing this pipeline prints is rotated, but a page box built as a
      // PdfRect comes back transposed here — `toRect` would rotate it a second
      // time — and that puts the link off the edge of the page rather than
      // merely somewhere wrong.
      final links = readerPageLinks(
        [_urlLink('https://example.org/a')],
        _FakePage(
          width: 842,
          height: 595,
          rotation: PdfPageRotation.clockwise90,
        ),
      );

      final rect = links.single.rects.single;
      expect(rect.left, closeTo(686 / 842, 1e-9));
      expect(rect.top, closeTo(72 / 595, 1e-9));
      expect(rect.width, closeTo((700 - 686) / 842, 1e-9));
      expect(rect.height, closeTo((300 - 72) / 595, 1e-9));
      expect(rect.left, lessThan(1), reason: 'a link has to be on the page');
    });

    test('keeps a destination link, which carries no url', () {
      final links = readerPageLinks([
        PdfLink([
          _sourceRect,
        ], dest: const PdfDest(3, PdfDestCommand.fit, null)),
      ], _FakePage());

      expect(links.single.dest?.pageNumber, 3);
      expect(links.single.url, isNull);
      expect(links.single.isFollowable, isTrue);
    });

    test('drops a link the reader would refuse, so it is not a dead spot', () {
      final links = readerPageLinks([
        _urlLink('javascript:alert(1)'),
        PdfLink([_sourceRect]),
      ], _FakePage());

      expect(links, isEmpty);
    });

    test('keeps every line of a link that wrapped', () {
      final links = readerPageLinks([
        PdfLink([
          const PdfRect(72, 700, 500, 686),
          const PdfRect(72, 684, 190, 670),
        ], url: Uri.parse('https://example.org/a')),
      ], _FakePage());

      expect(links.single.rects, hasLength(2));
    });
  });

  group('readerLinkAt', () {
    ReaderPageLink linkAt(double left, double top) => ReaderPageLink(
      rects: [NormRect(left, top, 0.2, 0.02)],
      url: Uri.parse('https://example.org/a'),
    );

    test('finds the link the tap landed on, and only that one', () {
      final links = [linkAt(0.1, 0.1), linkAt(0.1, 0.5)];

      expect(
        readerLinkAt(links, const NormPoint(0.15, 0.51)),
        same(links.last),
      );
      expect(readerLinkAt(links, const NormPoint(0.8, 0.8)), isNull);
      expect(readerLinkAt(const [], const NormPoint(0.1, 0.1)), isNull);
    });

    test('the later link wins where two overlap', () {
      final links = [linkAt(0.1, 0.1), linkAt(0.1, 0.1)];

      expect(readerLinkAt(links, const NormPoint(0.15, 0.11)), same(links[1]));
    });

    test('a line of type is grown to something a fingertip can hit', () {
      final link = linkAt(0.1, 0.1);

      // Just above the drawn rectangle: a miss without slop, a hit with it.
      expect(link.hitTest(const NormPoint(0.15, 0.095), slop: 0), isFalse);
      expect(link.hitTest(const NormPoint(0.15, 0.095)), isTrue);
    });
  });

  group('readerLinkDestIsReachable', () {
    test('refuses a page the book does not have', () {
      // PDFium answers −1 for a destination it cannot resolve, and pdfrx
      // indexes `pages[pageNumber - 1]` without checking.
      expect(
        readerLinkDestIsReachable(
          const PdfDest(-1, PdfDestCommand.fit, null),
          9,
        ),
        isFalse,
      );
      expect(
        readerLinkDestIsReachable(
          const PdfDest(0, PdfDestCommand.fit, null),
          9,
        ),
        isFalse,
      );
      expect(
        readerLinkDestIsReachable(
          const PdfDest(10, PdfDestCommand.fit, null),
          9,
        ),
        isFalse,
      );
      expect(
        readerLinkDestIsReachable(
          const PdfDest(9, PdfDestCommand.fit, null),
          9,
        ),
        isTrue,
      );
    });
  });

  group('followReaderLink', () {
    Future<bool> follow(
      WidgetTester tester,
      ReaderPageLink link, {
      required Future<bool> Function(Uri url) launcher,
    }) async {
      late bool followed;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [readerLinkLauncherProvider.overrideWithValue(launcher)],
          child: MaterialApp(
            home: Scaffold(
              body: Consumer(
                builder: (context, ref, _) => TextButton(
                  onPressed: () async {
                    followed = await followReaderLink(
                      context: context,
                      ref: ref,
                      controller: PdfViewerController(),
                      link: link,
                    );
                  },
                  child: const Text('tap'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('tap'));
      await tester.pumpAndSettle();
      return followed;
    }

    testWidgets('hands a citation to the browser', (tester) async {
      final opened = <Uri>[];
      final followed = await follow(
        tester,
        ReaderPageLink(
          rects: const [NormRect(0.1, 0.1, 0.2, 0.02)],
          url: Uri.parse('https://example.org/a'),
        ),
        launcher: (url) async {
          opened.add(url);
          return true;
        },
      );

      expect(followed, isTrue);
      expect(opened, [Uri.parse('https://example.org/a')]);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('says so when nothing can open the link', (tester) async {
      final followed = await follow(
        tester,
        ReaderPageLink(
          rects: const [NormRect(0.1, 0.1, 0.2, 0.02)],
          url: Uri.parse('https://example.org/a'),
        ),
        launcher: (_) async => false,
      );

      expect(followed, isTrue);
      expect(find.text('Could not open that link.'), findsOneWidget);
    });

    testWidgets('a launcher that throws is a message, not a crash', (
      tester,
    ) async {
      final followed = await follow(
        tester,
        ReaderPageLink(
          rects: const [NormRect(0.1, 0.1, 0.2, 0.02)],
          url: Uri.parse('https://example.org/a'),
        ),
        launcher: (_) async => throw Exception('no browser'),
      );

      expect(followed, isTrue);
      expect(find.text('Could not open that link.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leaves the tap alone when there is nowhere to go', (
      tester,
    ) async {
      var launched = false;
      final followed = await follow(
        tester,
        const ReaderPageLink(rects: [NormRect(0.1, 0.1, 0.2, 0.02)]),
        launcher: (_) async {
          launched = true;
          return true;
        },
      );

      expect(followed, isFalse, reason: 'the bars still have to move');
      expect(launched, isFalse);
    });

    testWidgets('declines a destination the viewer cannot resolve', (
      tester,
    ) async {
      final followed = await follow(
        tester,
        const ReaderPageLink(
          rects: [NormRect(0.1, 0.1, 0.2, 0.02)],
          dest: PdfDest(3, PdfDestCommand.fit, null),
        ),
        launcher: (_) async => true,
      );

      // The controller here has no document, which is the same shape as a
      // destination pointing past the end of the book: better the bars move
      // than a tap that does nothing.
      expect(followed, isFalse);
    });
  });
}
