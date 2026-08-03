import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/credit_log_screen.dart';

/// The credit log: what moved, which way, and what the reader is told about
/// entries that never really moved anything.

CreditLogEntry _entry({
  required String id,
  bool addsCredits = false,
  int credits = 430,
  CreditLogKind kind = CreditLogKind.spend,
  String title = 'Book generation',
  bool pending = false,
  bool refunded = false,
  String? projectTitle,
  DateTime? createdAt,
}) {
  return CreditLogEntry(
    id: id,
    createdAt: createdAt ?? DateTime.now().subtract(const Duration(hours: 2)),
    addsCredits: addsCredits,
    credits: credits,
    kind: kind,
    title: title,
    pending: pending,
    refunded: refunded,
    projectTitle: projectTitle,
  );
}

void main() {
  testWidgets('lists what came in and what went out, and says which is which', (
    tester,
  ) async {
    final repository = FakeCreditLogRepository([
      CreditLogPage(
        entries: [
          _entry(
            id: 'purchase',
            addsCredits: true,
            credits: 1000,
            kind: CreditLogKind.purchase,
            title: 'Credits purchased',
          ),
          _entry(id: 'spend', projectTitle: 'The Moon Rabbit'),
          _entry(
            id: 'hold',
            credits: 120,
            title: 'Audiobook',
            pending: true,
          ),
          _entry(
            id: 'released',
            credits: 80,
            title: 'Book edit',
            refunded: true,
          ),
        ],
      ),
    ]);

    await tester.pumpWidget(_screen(repository));
    await tester.pumpAndSettle();

    expect(find.text('+1,000'), findsOneWidget);
    expect(find.text('-430'), findsOneWidget);
    expect(find.text('Credits purchased'), findsOneWidget);
    expect(find.textContaining('The Moon Rabbit'), findsOneWidget);
    // A hold has left the balance but is not settled; a released one came back.
    expect(find.text('On hold'), findsOneWidget);
    expect(find.text('Refunded'), findsOneWidget);
    expect(repository.calls.single.cursor, isNull);
  });

  testWidgets('asks for the next page only once it is reached', (tester) async {
    final repository = FakeCreditLogRepository([
      CreditLogPage(
        entries: [
          for (var index = 0; index < 30; index += 1)
            _entry(id: 'entry-$index', title: 'Book generation $index'),
        ],
        nextCursor: 'entry-29',
      ),
      CreditLogPage(entries: [_entry(id: 'older', title: 'Older charge')]),
    ]);

    await tester.pumpWidget(_screen(repository));
    await tester.pumpAndSettle();

    expect(repository.calls, hasLength(1));

    await tester.scrollUntilVisible(
      find.text('Older charge'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(repository.calls.last.cursor, 'entry-29');
    expect(find.text('Older charge'), findsOneWidget);
  });

  testWidgets('keeps the loaded history when an older page fails', (
    tester,
  ) async {
    final repository = FakeCreditLogRepository([
      CreditLogPage(
        entries: [
          for (var index = 0; index < 30; index += 1)
            _entry(id: 'entry-$index', title: 'Book generation $index'),
        ],
        nextCursor: 'entry-29',
      ),
    ], failAfterFirstPage: true);

    await tester.pumpWidget(_screen(repository));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('Could not load older entries'),
      300,
      scrollable: find.byType(Scrollable).first,
    );

    expect(find.text('Could not load older entries'), findsOneWidget);
    // The page that did load is still there to scroll back to.
    await tester.scrollUntilVisible(
      find.text('Book generation 0'),
      -300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Book generation 0'), findsOneWidget);
  });

  testWidgets('says so plainly when there is no history yet', (tester) async {
    final repository = FakeCreditLogRepository([
      const CreditLogPage(entries: []),
    ]);

    await tester.pumpWidget(_screen(repository));
    await tester.pumpAndSettle();

    expect(find.text('No credit history yet'), findsOneWidget);
  });

  test('a day is named when a name is clearer than a date', () {
    final now = DateTime(2026, 6, 15, 9);
    expect(dayLabelFor(DateTime(2026, 6, 15, 2), now), 'Today');
    expect(dayLabelFor(DateTime(2026, 6, 14, 23), now), 'Yesterday');
    expect(dayLabelFor(DateTime(2026, 6, 2, 8), now), '2/6/2026');
  });

  test('screen readers hear the direction rather than a sign', () {
    expect(
      creditLogSemanticLabel(
        _entry(id: 'spend', projectTitle: 'The Moon Rabbit'),
      ),
      contains('430 credits used'),
    );
    expect(
      creditLogSemanticLabel(_entry(id: 'grant', addsCredits: true)),
      contains('430 credits added'),
    );
    expect(
      creditLogSemanticLabel(_entry(id: 'released', refunded: true)),
      contains('430 credits refunded'),
    );
  });
}

Widget _screen(FakeCreditLogRepository repository) {
  return ProviderScope(
    overrides: [creditLogRepositoryProvider.overrideWithValue(repository)],
    child: const MaterialApp(home: CreditLogScreen()),
  );
}

class CreditLogCall {
  const CreditLogCall({required this.cursor, required this.limit});

  final String? cursor;
  final int limit;
}

class FakeCreditLogRepository implements CreditLogRepository {
  FakeCreditLogRepository(this.pages, {this.failAfterFirstPage = false});

  final List<CreditLogPage> pages;
  final bool failAfterFirstPage;
  final calls = <CreditLogCall>[];

  @override
  Future<CreditLogPage> getCreditLog({String? cursor, int limit = 30}) async {
    calls.add(CreditLogCall(cursor: cursor, limit: limit));
    if (failAfterFirstPage && cursor != null) {
      throw Exception('offline');
    }
    return pages[calls.length - 1 < pages.length ? calls.length - 1 : 0];
  }
}
