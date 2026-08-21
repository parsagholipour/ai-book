import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/characters/domain/character_models.dart';

import 'character_test_support.dart';

/// Eleven library names, one past the ten a description may mention. None is a
/// sub-token of another, so each `@name` resolves on its own.
const _mentionNames = [
  'Ana',
  'Bea',
  'Cyd',
  'Dee',
  'Eve',
  'Fay',
  'Gus',
  'Hal',
  'Ivy',
  'Jo',
  'Kim',
];

/// Every `@name` link the character editor's description can carry: the chip
/// the reader taps, the token they type, the one the sheet resolves out of
/// pre-feature prose on its own — and what a rename arriving from another
/// device does to each of them. The rest of the sheet is asserted in
/// `character_editor_sheet_test.dart`.
void main() {
  /// The description the sheet is holding right now, which is what a respell
  /// writes and what Save reads.
  TextEditingController descriptionField(WidgetTester tester) => tester
      .widget<TextField>(
        find.byKey(const ValueKey('character-description-field')),
      )
      .controller!;

  /// Save, scrolled into view first: the sheet is taller than the viewport
  /// once a description and a few details are in it.
  Future<void> tapSave(WidgetTester tester) async {
    const save = ValueKey('character-editor-save');
    await tester.ensureVisible(find.byKey(save));
    await tester.tap(find.byKey(save));
  }

  testWidgets('typing @ offers another character and saves its durable id', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @',
    );
    await tester.pumpAndSettle();
    final suggestions = find.byKey(
      const ValueKey('character-mention-suggestions'),
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Bram')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Mina Park')),
      findsNothing,
    );

    await tester.tap(
      find.descendant(of: suggestions, matching: find.text('Bram')),
    );
    await tester.pumpAndSettle();
    expect(find.text('@Bram'), findsOneWidget);
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates.single['description'], 'Friends with @Bram');
    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
  });

  testWidgets('removing a saved token sends an authoritative empty link set', (
    tester,
  ) async {
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final mina = testCharacter(
      description: 'Friends with @Bram.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    expect(
      find.byKey(const ValueKey('character-description-mentions')),
      findsOneWidget,
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with @Bram.'),
      'Friends with Bram.',
    );
    await tester.tap(find.byKey(const ValueKey('character-editor-save')));
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], isEmpty);
  });

  testWidgets('the chip row stops one sentinel past the cap, not two', (
    tester,
  ) async {
    // The resolver already answers one past whatever limit it is handed, so
    // asking it for `cap + 1` asked for two sentinels: a twelfth chip in a
    // field that refuses an eleventh.
    final names = [..._mentionNames, 'Lex'];
    final mina = testCharacter(description: '');
    final others = [
      for (var index = 0; index < names.length; index++)
        testCharacter(id: 'char-${index + 2}', name: names[index]),
    ];
    await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, ...others],
    );

    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Knows ${names.map((name) => '@$name').join(' ')}.',
    );
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('character-description-mentions')),
        matching: find.byType(Chip),
      ),
      findsNWidgets(11),
    );
  });

  testWidgets('the chip row follows the prose, not the stored order', (
    tester,
  ) async {
    // The stored set and the resolved one hold the same two ids and differ
    // only in the order they come back in — and the chips are drawn from the
    // resolved one, in the order the description reads. The comparison behind
    // that swap is positional for exactly this reason: same-ids-in-any-order
    // leaves the row spelling an order the prose does not have.
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final cyd = testCharacter(id: 'char-3', name: 'Cyd');
    final mina = testCharacter(
      description: 'Friends with @Cyd and @Bram.',
      mentions: const [
        LibraryMention(id: 'char-2', name: 'Bram'),
        LibraryMention(id: 'char-3', name: 'Cyd'),
      ],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram, cyd],
    );

    final labels = tester
        .widgetList<Chip>(
          find.descendant(
            of: find.byKey(const ValueKey('character-description-mentions')),
            matching: find.byType(Chip),
          ),
        )
        .map((chip) => (chip.label as Text).data)
        .toList();
    expect(labels, ['@Cyd', '@Bram']);

    // Resolving the same links the character already had is not the reader
    // editing anything, so an unchanged form still pops without a request.
    await tapSave(tester);
    await tester.pumpAndSettle();
    expect(repository.updates, isEmpty);
  });

  testWidgets('a mention renamed under the sheet moves chip and prose with it', (
    tester,
  ) async {
    // Another device renames the linked character and the library poll brings
    // it back. Comparing ids alone left the chip and the stored `@token`
    // spelling a name nobody answers to any more — and the server respells its
    // own copy of every description that links to a renamed character, so the
    // stale token is one the next save is refused for.
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final mina = testCharacter(
      description: 'Friends with @Bram.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    expect(find.text('@Bram'), findsOneWidget);

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Nova'),
    );
    await pumpLibraryPoll(tester);

    expect(find.text('@Bram'), findsNothing);
    expect(find.text('@Nova'), findsOneWidget);
    expect(
      find.widgetWithText(TextField, 'Friends with @Nova.'),
      findsOneWidget,
    );

    // Following a rename is the sheet resolving a link, not the reader editing
    // — so an unchanged form still pops without a request.
    await tapSave(tester);
    await tester.pumpAndSettle();
    expect(repository.updates, isEmpty);
  });

  testWidgets('a rename claims its span against the whole linked set', (
    tester,
  ) async {
    // Two links whose names nest: renaming the short one must not eat the head
    // of the long one. The scan used to run with the renamed subset as its only
    // candidate, so "@Luna" claimed the "@Luna" inside "@Luna Vega" as well and
    // the field read "…@Nova and @Nova Vega." — while the server, which claims
    // with the description's whole link set, had stored "…@Nova and @Luna
    // Vega.". The two copies then disagreed about the same prose, and the next
    // save of it came back "The description no longer contains @Luna Vega."
    final luna = testCharacter(id: 'char-2', name: 'Luna');
    final vega = testCharacter(id: 'char-3', name: 'Luna Vega');
    final mina = testCharacter(
      description: 'Friends with @Luna and @Luna Vega.',
      mentions: const [
        LibraryMention(id: 'char-2', name: 'Luna'),
        LibraryMention(id: 'char-3', name: 'Luna Vega'),
      ],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, luna, vega],
    );

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Nova'),
    );
    await pumpLibraryPoll(tester);

    expect(descriptionField(tester).text, 'Friends with @Nova and @Luna Vega.');
    // Vega's link survives the rename of her neighbour, chip and all.
    final chips = find.descendant(
      of: find.byKey(const ValueKey('character-description-mentions')),
      matching: find.byType(Chip),
    );
    expect(chips, findsNWidgets(2));
    expect(find.text('@Nova'), findsOneWidget);
    expect(find.text('@Luna Vega'), findsOneWidget);

    await tapSave(tester);
    await tester.pumpAndSettle();
    expect(repository.updates, isEmpty);
  });

  testWidgets('a rename under a half-made selection keeps the selection', (
    tester,
  ) async {
    // The respell writes the field's value, so it decides what happens to the
    // selection. It used to collapse it unconditionally — and to the caret it
    // had computed, which is `-1` for anything but an already-collapsed one. A
    // reader dragging across a phrase when the 3-second poll delivered somebody
    // else's rename was left with no selection and no cursor at all.
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final mina = testCharacter(
      description: 'Friends with @Bram is here.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Bram')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    final field = find.byKey(const ValueKey('character-description-field'));
    final controller = tester.widget<TextField>(field).controller!;
    // "is here", the whole span after the mention.
    controller.selection = const TextSelection(
      baseOffset: 19,
      extentOffset: 26,
    );
    await tester.pumpAndSettle();

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Novalie'),
    );
    await pumpLibraryPoll(tester);

    expect(controller.text, 'Friends with @Novalie is here.');
    // Three characters longer, so both ends move three to the right and the
    // reader is still holding the same words.
    expect(controller.selection.baseOffset, 22);
    expect(controller.selection.extentOffset, 29);
    expect(controller.text.substring(22, 29), 'is here');
  });

  /// The sheet holding an edited description that all but fills the field,
  /// with one link in it — and then the poll delivering that link's rename to
  /// a name eight characters longer.
  ///
  /// The server accepts the rename because its own copy of this description is
  /// the short one it was last saved with; the long one only exists here.
  Future<FakeCharactersRepository> pumpRenameOverflow(
    WidgetTester tester,
  ) async {
    final al = testCharacter(id: 'char-2', name: 'Al');
    final mina = testCharacter(
      description: 'Friends with @Al.',
      mentions: const [LibraryMention(id: 'char-2', name: 'Al')],
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, al],
    );

    // 1995 of 2000 — the field's own formatter takes it, and nothing is over.
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      '${'x' * 1990} @Al.',
    );
    await tester.pumpAndSettle();
    expect(find.text('Too long to save.'), findsNothing);

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Alexandria'),
    );
    await pumpLibraryPoll(tester);
    return repository;
  }

  /// Lets the message a step already put on screen expire, so the next
  /// assertion reads the bar that step raised rather than one queued behind it.
  Future<void> clearSnackBars(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.byType(SnackBar), findsNothing);
  }

  testWidgets('a rename that outgrows the cap says so and shows the count', (
    tester,
  ) async {
    // The respell writes the field's value, so its maxLength formatter never
    // sees the longer token: prose the reader is holding grows by eight
    // characters because somebody on another device renamed a character they
    // mentioned. The counter is hidden on every field in this sheet, so
    // without both of these the overflow is invisible until Save is refused.
    await pumpRenameOverflow(tester);

    final controller = descriptionField(tester);
    expect(controller.text.endsWith(' @Alexandria.'), isTrue);
    expect(controller.text.length, 2003);
    expect(find.text('Too long to save.'), findsOneWidget);
    expect(find.text('2003/2000'), findsOneWidget);
    expect(
      find.textContaining('was renamed and the description is now too long'),
      findsOneWidget,
    );
  });

  testWidgets('a save whose description is past the cap is never sent', (
    tester,
  ) async {
    // Unstopped, that length reaches zod's `.max(2000)` and comes back from the
    // update route as "Send at least one change." — about the edit the reader
    // did make, for a length they did not and cannot see.
    final repository = await pumpRenameOverflow(tester);
    await clearSnackBars(tester);

    await tapSave(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(repository.updates, isEmpty);
    expect(
      find.text('The description is too long. Shorten it and save again.'),
      findsOneWidget,
    );
    // Refused, not closed: the sheet is where the prose can be shortened.
    expect(find.text('Edit character'), findsOneWidget);
  });

  testWidgets('shortening the prose after a rename lets the save through', (
    tester,
  ) async {
    // The whole point of showing the length: the refusal is one the reader can
    // act on, and acting on it clears both the error and the refusal.
    final repository = await pumpRenameOverflow(tester);
    await clearSnackBars(tester);

    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      '${'x' * 100} @Alexandria.',
    );
    await tester.pumpAndSettle();
    expect(find.text('Too long to save.'), findsNothing);

    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(
      repository.updates.single['description'],
      '${'x' * 100} @Alexandria.',
    );
    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
  });

  testWidgets('an unambiguous manually typed name resolves without a tap', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @Bram',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
  });

  testWidgets('a legacy @name the sheet resolved on its own is not a change', (
    tester,
  ) async {
    // A pre-feature character: plain prose, no durable link, and a description
    // the photo read that is still on offer. The sheet resolves the token as
    // soon as the library arrives, which must not turn a look-and-Save into a
    // PATCH — that one canonicalizes the prose, writes a link the reader never
    // made, and retires the suggestion they never acted on.
    final mina = testCharacter(
      description: 'Inspired by @bram',
      suggestedDescription: 'A girl in a yellow raincoat.',
    );
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    // The chip is the proof that the auto-resolution happened.
    expect(
      find.byKey(const ValueKey('character-description-mentions')),
      findsOneWidget,
    );

    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates, isEmpty);
    expect(find.text('Edit character'), findsNothing);
  });

  /// That same pre-feature character, with the link's target renamed on another
  /// device while the sheet is open.
  Future<FakeCharactersRepository> pumpLegacyRename(WidgetTester tester) async {
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final mina = testCharacter(description: 'Inspired by @bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );
    // The chip is the proof the sheet resolved the token by itself — nothing
    // durable links it and no suggestion chip was ever tapped, so the record of
    // what this session typed is empty for it.
    expect(find.text('@Bram'), findsOneWidget);

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Brom'),
    );
    await pumpLibraryPoll(tester);
    return repository;
  }

  testWidgets('a rename follows a link the sheet resolved out of the prose', (
    tester,
  ) async {
    // Following renames through the typed record alone reached none of these:
    // the token kept spelling a name nobody answers to, the resolver stopped
    // matching it, and the chip went out without a word.
    await pumpLegacyRename(tester);

    expect(descriptionField(tester).text, 'Inspired by @Brom');
    expect(find.text('@Brom'), findsOneWidget);
    expect(find.text('@Bram'), findsNothing);
  });

  testWidgets('a save after that rename leaves no @marker naming nobody', (
    tester,
  ) async {
    // Whatever prose reaches the server, every `@token` left in it has to be
    // one of the ids sent beside it. Unfollowed, this saved "@bram" with an
    // empty link set — a marker no later scan can ever repair, because nothing
    // downstream knows who it was pointing at.
    final repository = await pumpLegacyRename(tester);

    // The reader's own edit is what makes this a PATCH at all, and it carries
    // the respelled prose with it.
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      '${descriptionField(tester).text}, and brave.',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pumpAndSettle();

    final sent = repository.updates.single;
    expect(sent['description'], 'Inspired by @Brom, and brave.');
    expect(sent['mentionedCharacterIds'], ['char-2']);
    expect((sent['description']! as String).contains('@bram'), isFalse);
  });

  testWidgets('a prose-resolved rename still claims against the whole set', (
    tester,
  ) async {
    // Neither link is stored and neither was tapped, so both are claimants only
    // because the prose resolves them. The nesting rule has to hold over that
    // set too: renaming the short name must not take the span inside the long
    // one, or this copy and the server's disagree about the same prose.
    final luna = testCharacter(id: 'char-2', name: 'Luna');
    final vega = testCharacter(id: 'char-3', name: 'Luna Vega');
    final mina = testCharacter(
      description: 'Friends with @Luna and @Luna Vega.',
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, luna, vega],
    );

    repository.replaceLibraryCharacter(
      testCharacter(id: 'char-2', name: 'Nova'),
    );
    await pumpLibraryPoll(tester);

    expect(descriptionField(tester).text, 'Friends with @Nova and @Luna Vega.');
    expect(find.text('@Nova'), findsOneWidget);
    expect(find.text('@Luna Vega'), findsOneWidget);
  });

  testWidgets('a rename respells a non-Latin token without splitting a name', (
    tester,
  ) async {
    // The respell claims through the same scanner the rest of the sheet does,
    // and that scanner counts ZWNJ as *inside* a word: «علی‌رضا» is one name.
    // Neither link here is stored or tapped, so both reach the claim only as
    // resolved ones — and a boundary read the other way would let the short
    // name take the head of the long one and hand one saved face to another.
    const ali = '\u0639\u0644\u06cc';
    const alireza = '\u0639\u0644\u06cc\u200c\u0631\u0636\u0627';
    const nova = '\u0646\u0648\u0627';
    final mina = testCharacter(
      description: '\u0647\u0645\u0631\u0627\u0647 @$ali \u0648 @$alireza.',
    );
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [
        mina,
        testCharacter(id: 'char-2', name: ali),
        testCharacter(id: 'char-3', name: alireza),
      ],
    );
    expect(find.text('@$alireza'), findsOneWidget);

    repository.replaceLibraryCharacter(testCharacter(id: 'char-2', name: nova));
    await pumpLibraryPoll(tester);

    expect(
      descriptionField(tester).text,
      '\u0647\u0645\u0631\u0627\u0647 @$nova \u0648 @$alireza.',
    );
    expect(find.text('@$nova'), findsOneWidget);
    expect(find.text('@$alireza'), findsOneWidget);
  });

  testWidgets('a chip that still fits at the cap is inserted', (tester) async {
    final mina = testCharacter(description: '');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    final field = find.byKey(const ValueKey('character-description-field'));
    await tester.enterText(field, '${'x' * 1993} @');
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Bram'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final controller = tester.widget<TextField>(field).controller!;
    expect(controller.text.length, 2000);
    expect(controller.text.endsWith('@Bram '), isTrue);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('a chip that would pass the cap is refused, changing nothing', (
    tester,
  ) async {
    // Nothing enforces the cap on the way in — without the check the
    // description goes past the server's and the save comes back as a generic
    // error with nothing on screen to explain it. The boundary is the candidate
    // as Save would send it, so the space the chip leaves behind is not length:
    // one `x` fewer than this fits, trailing space and all.
    final mina = testCharacter(description: '');
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    final field = find.byKey(const ValueKey('character-description-field'));
    final typed = '${'x' * 1995} @';
    await tester.enterText(field, typed);
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Bram'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.widget<TextField>(field).controller!.text, typed);
    expect(
      find.text('That would make the description too long.'),
      findsOneWidget,
    );
  });

  testWidgets('the eleventh mention chip is refused', (tester) async {
    final mina = testCharacter(description: '');
    final others = [
      for (var index = 0; index < _mentionNames.length; index++)
        testCharacter(id: 'char-${index + 2}', name: _mentionNames[index]),
    ];
    await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, ...others],
    );

    final field = find.byKey(const ValueKey('character-description-field'));
    final tokens = _mentionNames.take(10).map((name) => '@$name').join(' ');
    // The trailing fragment narrows the suggestion row to the one chip.
    await tester.enterText(field, 'Knows $tokens @Ki');
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('character-mention-suggestions')),
        matching: find.text('Kim'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(
      tester.widget<TextField>(field).controller!.text,
      'Knows $tokens @Ki',
    );
    expect(
      find.text('A description can mention up to 10 characters.'),
      findsOneWidget,
    );
  });

  testWidgets('a save carrying more mentions than the cap is refused', (
    tester,
  ) async {
    // The resolver used to trim the set to the cap, so a save quietly deleted
    // a link the reader could still see in their own prose. Saying so is the
    // only honest answer.
    final mina = testCharacter(description: '');
    final others = [
      for (var index = 0; index < _mentionNames.length; index++)
        testCharacter(id: 'char-${index + 2}', name: _mentionNames[index]),
    ];
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, ...others],
    );

    final tokens = _mentionNames.map((name) => '@$name').join(' ');
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Knows $tokens.',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(repository.updates, isEmpty);
    expect(find.textContaining('mention up to 10 characters'), findsOneWidget);
    expect(find.text('Edit character'), findsOneWidget);
  });

  testWidgets('a case-ambiguous typed name remains unlinked until picked', (
    tester,
  ) async {
    final mina = testCharacter(description: 'Friends with ');
    final upper = testCharacter(id: 'char-2', name: 'Bram');
    final lower = testCharacter(id: 'char-3', name: 'bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, upper, lower],
    );

    await tester.enterText(
      find.widgetWithText(TextField, 'Friends with '),
      'Friends with @BRAM',
    );
    await tester.pumpAndSettle();
    final suggestions = find.byKey(
      const ValueKey('character-mention-suggestions'),
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('Bram')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: suggestions, matching: find.text('bram')),
      findsOneWidget,
    );
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], isEmpty);
  });

  /// A character whose description also links somewhere the character library
  /// cannot answer for. Only CHARACTER rows are written today, so this is the
  /// forward-compatibility case [LibraryMentionKind] exists for: the build that
  /// meets the first location row is one already on a phone.
  LibraryCharacter minaWithHarbour() => testCharacter(
    description: 'Lives near @Harbor with @Bram.',
    mentions: const [
      LibraryMention(
        id: 'loc-1',
        name: 'Harbor',
        kind: LibraryMentionKind.location,
      ),
      LibraryMention(id: 'char-2', name: 'Bram'),
    ],
  );

  testWidgets('a stored location link is never sent as a character id', (
    tester,
  ) async {
    // The whole failure chain in one save: seeded as an inserted token, the
    // place is resolved as a character candidate, chipped as one, and its id
    // travels in `mentionedCharacterIds` — which the update route looks up in
    // `libraryCharacter`, finds one row short, and answers 404
    // "A mentioned character is no longer in your library." Every save of this
    // character's description fails, and nothing the reader can type fixes it.
    // The repository double refuses the same set the route would.
    final mina = minaWithHarbour();
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Lives near @Harbor with @Bram. Always muddy.',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates.single['mentionedCharacterIds'], ['char-2']);
    // The save went through: the sheet popped, and no refusal was shown.
    expect(find.text('Edit character'), findsNothing);
    expect(find.textContaining('no longer in your library'), findsNothing);
  });

  testWidgets('a stored location marker survives the save untouched', (
    tester,
  ) async {
    // Dropping the id is safe only because nothing else here touches the link.
    // The prose goes up verbatim, `@Harbor` and all — the update route
    // canonicalizes only the spans its character targets claim — and its
    // `deleteMany` names `REPLACED_MENTION_KINDS`, CHARACTER alone, so the
    // stored LOCATION row outlives the write (`libraryMentionLinks.test.ts`
    // pins that half). The alternative bug is worse than the 404: an ordinary
    // description edit that silently unlinks the reader's places.
    final mina = minaWithHarbour();
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    // No chip for it either: a place drawn beside the cast, with a face on it,
    // is a link the reader would reasonably try to remove from here.
    final chips = find.byKey(const ValueKey('character-description-mentions'));
    expect(
      find.descendant(of: chips, matching: find.text('@Bram')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: chips, matching: find.text('@Harbor')),
      findsNothing,
    );

    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Lives near @Harbor with @Bram. Always muddy.',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(
      repository.updates.single['description'],
      'Lives near @Harbor with @Bram. Always muddy.',
    );
  });

  testWidgets('a location link is not a change the reader made', (
    tester,
  ) async {
    // Typed into and typed back out of: name, details and prose all end where
    // they started, so an unchanged form pops without a request. Compared
    // against the whole stored list instead of the cast, the location the sheet
    // does not send read as a link the reader had just removed, and every such
    // look-and-Save wrote the cast back for nothing.
    final mina = minaWithHarbour();
    final bram = testCharacter(id: 'char-2', name: 'Bram');
    final repository = await pumpCharacterEditorSheet(
      tester,
      mina,
      libraryCharacters: [mina, bram],
    );

    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Lives near @Harbor with @Bram. x',
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('character-description-field')),
      'Lives near @Harbor with @Bram.',
    );
    await tester.pumpAndSettle();
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(repository.updates, isEmpty);
    expect(find.text('Edit character'), findsNothing);
  });
}
