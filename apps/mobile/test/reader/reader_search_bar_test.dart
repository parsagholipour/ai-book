import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/presentation/reader_search_bar.dart';

class _FakePdfTextSearcher implements PdfTextSearcher {
  final List<VoidCallback> _listeners = [];
  bool wasReset = false;

  @override
  List<PdfPageTextRange> get matches => const [];

  @override
  int? get currentIndex => null;

  @override
  bool get isSearching => false;

  @override
  VoidCallback addListener(VoidCallback listener) {
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  @override
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  @override
  void resetTextSearch() {
    wasReset = true;
  }

  @override
  Future<int> goToNextMatch() async => -1;

  @override
  Future<int> goToPrevMatch() async => -1;

  @override
  void startTextSearch(
    Pattern pattern, {
    bool caseInsensitive = true,
    bool goToFirstMatch = true,
    bool searchImmediately = false,
  }) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ReaderRoute extends StatefulWidget {
  const _ReaderRoute({required this.searcher});

  final PdfTextSearcher searcher;

  @override
  State<_ReaderRoute> createState() => _ReaderRouteState();
}

class _ReaderRouteState extends State<_ReaderRoute> {
  bool _searching = true;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _searching
          ? ReaderSearchBar(
              searcher: widget.searcher,
              onClose: () => setState(() => _searching = false),
            )
          : const Center(child: Text('Book remains open')),
    );
  }
}

void main() {
  testWidgets('mobile back closes search before it closes the book', (
    tester,
  ) async {
    final searcher = _FakePdfTextSearcher();

    await tester.pumpWidget(
      MaterialApp(
        initialRoute: '/reader',
        routes: {
          '/': (_) => const Scaffold(body: Text('Book shelf')),
          '/reader': (_) => _ReaderRoute(searcher: searcher),
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ReaderSearchBar), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(searcher.wasReset, isTrue);
    expect(find.byType(ReaderSearchBar), findsNothing);
    expect(find.text('Book remains open'), findsOneWidget);
    expect(find.text('Book shelf'), findsNothing);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.text('Book shelf'), findsOneWidget);
  });
}
