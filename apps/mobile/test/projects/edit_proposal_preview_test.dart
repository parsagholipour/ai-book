import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/edit_proposal_card.dart';

void main() {
  Map<String, dynamic> proposalJson({Map<String, dynamic>? preview}) => {
    'id': 'proposal-1',
    'kind': 'local_patch',
    'scope': 'all_pages',
    'affectedPageIndexes': [1, 2],
    'credits': 0,
    'summary': 'Replace “rabbit” with “fly”',
    'preview': ?preview,
  };

  test('parses an exact-replacement preview', () {
    final proposal = MobileEditProposal.fromJson(
      proposalJson(
        preview: {
          'kind': 'exact_replace',
          'from': 'rabbit',
          'to': 'fly',
          'matchCount': 2,
          'samples': [
            {'pageIndex': 1, 'before': 'Rabbit runs.', 'after': 'Fly runs.'},
          ],
        },
      ),
    );

    expect(proposal.credits, 0);
    expect(proposal.preview, isNotNull);
    expect(proposal.preview!.samples.single.before, 'Rabbit runs.');
    expect(proposal.preview!.samples.single.after, 'Fly runs.');
  });

  test('ignores a preview it cannot render', () {
    // A model rewrite has no computable result, so there is nothing to show.
    expect(MobileEditProposal.fromJson(proposalJson()).preview, isNull);
    expect(
      MobileEditProposal.fromJson(
        proposalJson(preview: {'kind': 'something_else', 'samples': []}),
      ).preview,
      isNull,
    );
    expect(
      MobileEditProposal.fromJson(
        proposalJson(preview: {'kind': 'exact_replace', 'samples': []}),
      ).preview,
      isNull,
    );
  });

  testWidgets('draws the before and after lines, and no credit badge when free', (tester) async {
    final proposal = MobileEditProposal.fromJson(
      proposalJson(
        preview: {
          'kind': 'exact_replace',
          'from': 'rabbit',
          'to': 'fly',
          'matchCount': 2,
          'samples': [
            {'pageIndex': 1, 'before': 'Rabbit runs.', 'after': 'Fly runs.'},
            {'pageIndex': 2, 'before': 'Rabbit rests.', 'after': 'Fly rests.'},
          ],
        },
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: EditProposalCard(
            proposal: proposal,
            enabled: true,
            onApply: () {},
            onCancel: () {},
          ),
        ),
      ),
    );

    expect(find.text('Rabbit runs.'), findsOneWidget);
    expect(find.text('Fly runs.'), findsOneWidget);
    expect(find.text('Rabbit rests.'), findsOneWidget);
    expect(find.text('Fly rests.'), findsOneWidget);
    expect(find.text('Apply'), findsOneWidget);
    // Nothing is charged, so the card must not show a price.
    expect(find.textContaining('credit'), findsNothing);
  });
}
