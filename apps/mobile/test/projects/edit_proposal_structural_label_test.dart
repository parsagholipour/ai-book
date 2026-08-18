import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

/// The chip on a restructure card is drawn from the `structural` block alone —
/// a structural edit's `affectedPageIndexes` are empty by design — so every
/// placement the server can propose has to be readable off that block.
void main() {
  MobileEditProposal proposalWith(Map<String, dynamic> structural) =>
      MobileEditProposal.fromJson({
        'id': 'proposal-1',
        'kind': 'restructure_pages',
        'scope': 'none',
        'affectedPageIndexes': const <int>[],
        'credits': 40,
        'summary': 'Change which pages the book has',
        'structural': structural,
      });

  test('names the front of the book for an insert that opens it', () {
    // The head of the book has no page for the new one to follow, so the
    // server marks it instead of naming one. Read without the marker this is
    // indistinguishable from an insert that named no place at all, and the
    // chip said "at the end" — the opposite end from the one asked for.
    final proposal = proposalWith({
      'action': 'insert',
      'pageCount': 1,
      'totalPages': 3,
      'placement': 'front',
      'atFrontOfBook': true,
    });

    expect(proposal.structural!.placement, MobileStructuralPlacement.front);
    expect(proposal.pageLabel, '+1 at the front');
  });

  test('still says at the end when the request named no place', () {
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 2,
        'totalPages': 4,
        'placement': 'end',
      }).pageLabel,
      '+2 at the end',
    );
  });

  test('names the printed page an anchored insert follows', () {
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 2,
        'totalPages': 4,
        'placement': 'after',
        'afterReaderPage': 3,
      }).pageLabel,
      'After page 3 (+2)',
    );
  });

  test('names where a move lands, which is the point of a move', () {
    // The chip used to say "Pages 2, 3 move" and stop there, while the sentence
    // above it said where — the server sent both placement fields for an insert
    // only. Both halves of the card now read one resolved placement.
    expect(
      proposalWith({
        'action': 'move',
        'pageCount': 2,
        'totalPages': 5,
        'placement': 'after',
        'afterReaderPage': 4,
        'readerPageNumbers': const [2, 3],
      }).pageLabel,
      'Pages 2, 3 move after page 4',
    );
    expect(
      proposalWith({
        'action': 'move',
        'pageCount': 1,
        'totalPages': 5,
        'placement': 'front',
        'atFrontOfBook': true,
        'readerPageNumbers': const [3],
      }).pageLabel,
      'Page 3 moves to the front',
    );
  });

  test('says only what it knows when the server could not name the place', () {
    // A page an earlier edit added has no printed number until the recompile
    // publishes, so the server sends no destination rather than a model index
    // the reader would read as a printed page. The chip says as much: claiming
    // the end of the book would name a place nobody asked for.
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 2,
        'totalPages': 7,
        'placement': 'unnamed',
      }).pageLabel,
      '+2 pages',
    );
    expect(
      proposalWith({
        'action': 'move',
        'pageCount': 1,
        'totalPages': 5,
        'placement': 'unnamed',
        'readerPageNumbers': const [3],
      }).pageLabel,
      'Page 3 moves',
    );
  });

  test('reads a card stored before the server named the placement', () {
    // Proposals live on the chat message and are re-served with the transcript,
    // so cards written before `placement` existed outlive it. The marker, the
    // anchor and "neither means an append" are the reading this label has always
    // applied to them.
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 1,
        'totalPages': 3,
        'atFrontOfBook': true,
      }).pageLabel,
      '+1 at the front',
    );
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 2,
        'totalPages': 4,
        'afterReaderPage': 3,
      }).pageLabel,
      'After page 3 (+2)',
    );
    expect(
      proposalWith({
        'action': 'insert',
        'pageCount': 2,
        'totalPages': 4,
      }).pageLabel,
      '+2 at the end',
    );
    // A move from those days carried no destination at all, and inferring the
    // append an anchorless *insert* means would send it to the wrong end of the
    // book — so it says what it used to say.
    expect(
      proposalWith({
        'action': 'move',
        'pageCount': 1,
        'totalPages': 5,
        'readerPageNumbers': const [2],
      }).pageLabel,
      'Page 2 moves',
    );
  });
}
