import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_proposal_card.dart';

MobileEditProposal _proposal({
  int credits = 80,
  String kind = 'page_rewrite',
  String summary = 'Rewrite page 3 so it sounds warmer',
  Map<String, dynamic>? structural,
  Map<String, dynamic>? preview,
}) => MobileEditProposal.fromJson({
  'id': 'proposal-1',
  'kind': kind,
  'scope': 'pages',
  'affectedPageIndexes': structural == null ? const [3] : const <int>[],
  'readerPageNumbers': structural == null ? const [3] : const <int>[],
  'credits': credits,
  'summary': summary,
  'structural': ?structural,
  'preview': ?preview,
});

Widget _host(Widget card, {double textScale = 1}) => MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(
      context,
    ).copyWith(textScaler: TextScaler.linear(textScale)),
    child: child!,
  ),
  home: Scaffold(body: SingleChildScrollView(child: card)),
);

void main() {
  testWidgets('an open paid proposal shows scope, price and both actions', (
    tester,
  ) async {
    var applied = 0;
    var cancelled = 0;
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(),
          enabled: true,
          onApply: () => applied++,
          onCancel: () => cancelled++,
        ),
      ),
    );

    expect(find.text('Rewrite page 3 so it sounds warmer'), findsOneWidget);
    expect(find.text('Rewrite'), findsOneWidget);
    expect(find.text('Page 3'), findsOneWidget);
    // The price is a badge, never a sentence, and a paid edit is not "Free".
    expect(find.text('80'), findsOneWidget);
    expect(find.text('Free'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('edit-proposal-apply')));
    await tester.tap(find.byKey(const ValueKey('edit-proposal-cancel')));
    expect(applied, 1);
    expect(cancelled, 1);
  });

  testWidgets('a free proposal says it is free', (tester) async {
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(credits: 0, kind: 'local_patch'),
          enabled: true,
          onApply: () {},
          onCancel: () {},
        ),
      ),
    );

    expect(find.text('Free'), findsOneWidget);
    expect(find.text('Text fix'), findsOneWidget);
  });

  testWidgets('the changed words are marked in the before and after lines', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(
            credits: 0,
            kind: 'local_patch',
            preview: {
              'kind': 'exact_replace',
              'samples': [
                {
                  'before': 'The city slept under a heavy night sky.',
                  'after': 'The city slept under a heavy day sky.',
                },
              ],
            },
          ),
          enabled: true,
          onApply: () {},
          onCancel: () {},
        ),
      ),
    );

    expect(find.text('Before'), findsOneWidget);
    expect(find.text('After'), findsOneWidget);
    final before = tester.widget<Text>(
      find.text('The city slept under a heavy night sky.'),
    );
    final marked = (before.textSpan! as TextSpan).children!
        .cast<TextSpan>()
        .where((span) => span.style?.backgroundColor != null)
        .map((span) => span.text?.trim());
    expect(marked, ['night']);
  });

  testWidgets('a page insert says how long the book becomes', (tester) async {
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(
            kind: 'restructure_pages',
            summary: 'Add 2 pages after page 6',
            structural: {
              'action': 'insert',
              'pageCount': 2,
              'totalPages': 30,
              'placement': 'after',
              'afterReaderPage': 6,
            },
          ),
          enabled: true,
          onApply: () {},
          onCancel: () {},
        ),
      ),
    );

    expect(find.text('Add pages'), findsOneWidget);
    expect(find.text('After page 6 (+2)'), findsOneWidget);
    expect(find.text('Your book goes from 28 to 30 pages.'), findsOneWidget);
  });

  testWidgets('applying swaps the buttons for progress', (tester) async {
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(),
          enabled: false,
          applying: true,
          onApply: () {},
          onCancel: () {},
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Starting your edit…'), findsOneWidget);
    expect(find.byKey(const ValueKey('edit-proposal-apply')), findsNothing);
    expect(find.byKey(const ValueKey('edit-proposal-cancel')), findsNothing);
  });

  testWidgets('a settled proposal collapses and names how it ended', (
    tester,
  ) async {
    for (final (outcome, label) in [
      (EditProposalOutcome.applied, 'Applied'),
      (EditProposalOutcome.cancelled, 'Cancelled'),
      (null, 'Closed'),
    ]) {
      await tester.pumpWidget(
        _host(
          EditProposalCard(
            proposal: _proposal(),
            enabled: true,
            outcome: outcome,
          ),
        ),
      );
      expect(find.text(label), findsOneWidget, reason: '$outcome');
      expect(find.text('Apply'), findsNothing);
      expect(find.text('Cancel'), findsNothing);
    }
  });

  testWidgets('a long instruction is folded behind Show all, not cut off', (
    tester,
  ) async {
    final long = List.filled(60, 'keep the ending gentle').join(' and ');
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(summary: long),
          enabled: true,
          onApply: () {},
          onCancel: () {},
        ),
      ),
    );

    expect(find.text('Show all'), findsOneWidget);
    await tester.tap(find.text('Show all'));
    await tester.pumpAndSettle();
    expect(find.text('Show less'), findsOneWidget);
    expect(tester.widget<Text>(find.text(long)).maxLines, isNull);
  });

  testWidgets('stacks Apply above Cancel at a large text size', (tester) async {
    await tester.pumpWidget(
      _host(
        EditProposalCard(
          proposal: _proposal(),
          enabled: true,
          onApply: () {},
          onCancel: () {},
        ),
        textScale: 1.6,
      ),
    );

    final apply = tester.getTopLeft(
      find.byKey(const ValueKey('edit-proposal-apply')),
    );
    final cancel = tester.getTopLeft(
      find.byKey(const ValueKey('edit-proposal-cancel')),
    );
    expect(apply.dy, lessThan(cancel.dy));
    expect(tester.takeException(), isNull);
  });
}
