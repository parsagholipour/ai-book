import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

import 'character_test_support.dart';

/// What counts as a *change* to the links a description carries, and when the
/// editor sheet goes looking for one.
///
/// The first question is asked twice, of two different pairs of lists: the
/// chips are redrawn from whatever the prose resolves to now, and the save
/// compares that set's ids against the ones the character was opened with.
/// Neither question answers for the other, and the first case below is the one
/// that tells them apart — so it is the case a single shared predicate would
/// get wrong.
///
/// The second is about cost. Following a rename is a *library* change, so it is
/// asked once per delivery of the library and never off a keystroke; the two
/// cases after it pin both halves of that — the keystroke that no longer walks
/// the library, and the delivery that still respells prose the resolve itself
/// has stopped looking at.
///
/// The rest of the `@name` assertions — typing, chips, caps, renames, the links
/// this sheet does not own — live in `character_editor_mentions_test.dart`,
/// which is at its file-size budget.
void main() {
  testWidgets('a renamed link redraws a chip without writing a link', (
    tester,
  ) async {
    // One id under a name the library has moved on from. The chips are drawn
    // from the resolved set, so the name has to redraw them; only ids ever
    // travel in a save, so the same name is not a change the reader made. One
    // predicate for both answers whichever question it is not: comparing ids
    // alone leaves the chip spelling a name nobody answers to, and comparing
    // names too writes the cast back over prose the reader never touched.
    //
    // Fed here as the record the sheet was opened with still spelling the old
    // name while the library it resolves against already spells the new one —
    // the window between the caller's snapshot and the next poll.
    final mina = testCharacter(
      description: 'Friends with @Nova.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [
        mina,
        testCharacter(id: 'char-2', name: 'Nova'),
      ],
    );

    final chips = find.byKey(const ValueKey('character-description-mentions'));
    expect(
      find.descendant(of: chips, matching: find.text('@Nova')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: chips, matching: find.text('@Bram')),
      findsNothing,
    );

    // Typed into and typed back out of, which is the only thing that carries a
    // save as far as the link comparison. Nothing here is a change: the prose
    // ends where it started, and so does every id in it.
    const field = ValueKey('character-description-field');
    await tester.enterText(find.byKey(field), 'Friends with @Nova. x');
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(field), 'Friends with @Nova.');
    await tester.pumpAndSettle();
    const save = ValueKey('character-editor-save');
    await tester.ensureVisible(find.byKey(save));
    await tester.tap(find.byKey(save));
    await tester.pumpAndSettle();

    expect(repository.updates, isEmpty);
    expect(find.text('Edit character'), findsNothing);
  });

  testWidgets('a description keystroke never asks the library for a rename', (
    tester,
  ) async {
    // A rename is a change to somebody else's row, and the only thing that can
    // deliver one is `charactersProvider`. Asking after every keystroke — where
    // the question sat, in front of the over-cap short-circuit that exists to
    // stop per-keystroke work — walked the whole library into `namesById` and
    // rebuilt the claimant set once per character typed, for an answer that
    // cannot have moved since the last delivery.
    //
    // The edited character's own name is the probe, because it is the one name
    // only that walk reads: `resolveLibraryMentions` drops it by id before it
    // reads a name off anything, and so does the suggestion strip.
    final mina = _NameCountingCharacter(
      testCharacter(
        description: 'Friends with @Bram.',
        mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
      ),
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [
        mina,
        testCharacter(id: 'char-2', name: 'Bram'),
      ],
    );

    mina.nameReads = 0;
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Friends with @Bram. Muddy.',
    );
    await tester.pumpAndSettle();

    expect(mina.nameReads, 0);
    // Not zero because the sheet did nothing: the keystroke still resolved the
    // prose it was typed into, which is the work this guard is protecting.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('character-description-mentions')),
        matching: find.text('@Bram'),
      ),
      findsOneWidget,
    );

    // And the delivery that can carry a rename still follows one, straight off
    // the subscription rather than off the next thing the reader types.
    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Nova'),
    );
    await pumpLibraryPoll(tester);

    expect(mina.nameReads, greaterThan(0));
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('character-description-field')),
          )
          .controller!
          .text,
      'Friends with @Nova. Muddy.',
    );
  });

  testWidgets('a rename still reaches prose parked past the description cap', (
    tester,
  ) async {
    // The short-circuit the question used to sit in front of. Following a
    // rename is not something shortening the prose could do instead — the token
    // is left naming nobody either way — so it may not be one of the things
    // being over the cap switches off. Off the subscription it never was: the
    // guard is inside the resolve, and the resolve is not where the rename is
    // asked about any more.
    final mina = testCharacter(
      description: 'Friends with @Bram.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [
        mina,
        testCharacter(id: 'char-2', name: 'Bram'),
      ],
    );

    const field = ValueKey('character-description-field');
    await tester.enterText(find.byKey(field), '${'x' * 2090} @Bram.');
    await tester.pumpAndSettle();
    expect(find.text('Too long to save.'), findsOneWidget);

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Nova'),
    );
    await pumpLibraryPoll(tester);

    final controller = tester.widget<TextField>(find.byKey(field)).controller!;
    expect(controller.text, '${'x' * 2090} @Nova.');
    // Still over, and still saying so: a respell is not a way back under.
    expect(find.text('Too long to save.'), findsOneWidget);
  });
}

/// [LibraryCharacter] that counts every read of its [name].
///
/// The editor sheet reads the edited character's name in exactly one place per
/// keystroke — the `namesById` walk that looks for a rename — so a count is the
/// only way to say that walk did not happen. Everything else about the sheet is
/// asserted through what it draws or sends.
class _NameCountingCharacter extends LibraryCharacter {
  _NameCountingCharacter(LibraryCharacter character)
    : super(
        id: character.id,
        name: character.name,
        description: character.description,
        mentions: character.mentions,
        fields: character.fields,
        portraitStatus: character.portraitStatus,
        portraitError: character.portraitError,
        portraitSource: character.portraitSource,
        hasPhoto: character.hasPhoto,
        photoKind: character.photoKind,
        suggestedDescription: character.suggestedDescription,
        usedInBooks: character.usedInBooks,
        photoUrl: character.photoUrl,
        portraitUrl: character.portraitUrl,
        createdAt: character.createdAt,
        updatedAt: character.updatedAt,
      );

  int nameReads = 0;

  @override
  String get name {
    nameReads += 1;
    return super.name;
  }
}
