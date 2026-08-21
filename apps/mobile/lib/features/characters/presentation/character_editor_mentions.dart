part of 'character_editor_sheet.dart';

/// The editor sheet's @mention machinery: what the description is bound to,
/// what the reader is offered, and how a rename is followed into prose they are
/// holding.
///
/// A mixin in a part file rather than a module of its own, because every one of
/// these methods reads or writes the sheet's own state — the description
/// controller, the library the sheet is watching, the pending query the
/// suggestion strip is drawn from — and a class body cannot be split across
/// files. Privacy is library-scoped, so a part keeps all of it private to the
/// sheet exactly as it was.
///
/// **The seam is the cluster's own.** It owns the four pieces of state nothing
/// else writes ([_savedCharacterMentions], [_insertedMentionTextById],
/// [_attachedMentions], [_mentionQuery]), plus the two derived from the
/// description's cap, and borrows exactly three things back from the sheet: the
/// controller whose text every answer here is about, the saved row (so a
/// character cannot mention itself), and whether a save is in flight. Those are
/// the abstract members below, and their small number is what says the split is
/// along a real boundary rather than at a line count.
mixin _CharacterEditorMentions on ConsumerState<_CharacterEditorSheet> {
  /// The description every answer in here is about. Declared by the sheet,
  /// because the name field, the save and the build read it too.
  TextEditingController get _descriptionController;

  /// The character as the server last confirmed it, or null before the first
  /// save. Only its id is wanted — a character may not mention itself — and it
  /// moves when a create lands, which is why it is read rather than captured.
  LibraryCharacter? get _saved;

  /// Whether a save or a suggestion call is in flight, which is what greys the
  /// suggestion chips out.
  bool get _busy;

  /// The stored links this sheet may treat as characters, and the one place it
  /// decides that.
  ///
  /// Both seeds below come off this, so a link into some *other* library never
  /// becomes an inserted token, a chip, a claimant of a span, or an id in
  /// `mentionedCharacterIds` — [LibraryCharacter.characterMentions] holds why
  /// the stored list is wider than the cast, and what a location id costs once
  /// it reaches the update route. Filtering at the wire instead would have
  /// fixed only the 404: the place would still be resolved as a character
  /// everywhere upstream of it — drawn with a face, counted against
  /// [_mentionsMax], and offered to somebody else's rename as a span to
  /// respell.
  ///
  /// The markers themselves are left exactly where the reader has them. An
  /// `@Harbor` nobody here claims is ordinary prose to this sheet, and to the
  /// save: the description travels verbatim, the update route canonicalizes
  /// only the spans its character targets claim, and its `deleteMany` names
  /// `REPLACED_MENTION_KINDS` — CHARACTER alone — so the stored location row
  /// outlives every description save. Preserved, not owned: this sheet cannot
  /// yet show that link, add one, or take one away.
  late final List<LibraryMention> _savedCharacterMentions =
      widget.character?.characterMentions ?? const <LibraryMention>[];
  late final Map<String, String> _insertedMentionTextById = {
    for (final mention in _savedCharacterMentions)
      mention.id: '@${mention.name}',
  };
  late List<LibraryMention> _attachedMentions = _savedCharacterMentions;
  LibraryMentionQuery? _mentionQuery;

  /// How far the description is past its cap right now; 0 while it fits.
  ///
  /// Held in state because nothing between the field and the route enforces
  /// that cap — [CharacterDescriptionField]'s `maxLength` is advisory on
  /// purpose — and this sheet hides every counter. A length nobody can see is a
  /// Save refused for a reason nobody can see.
  int _descriptionOverflow = 0;

  /// Whether the reader themselves changed the description — typed in it, took
  /// the photo suggestion, or tapped a mention chip.
  ///
  /// It is tracked rather than derived, because the sheet resolves mentions on
  /// its own: a pre-feature character whose prose says "Inspired by @bram" gets
  /// a link the moment the library arrives, which is a change to
  /// [_attachedMentions] that no comparison can tell from an edit. Deriving
  /// "changed" from that state turned a look-and-Save into a PATCH — one that
  /// canonicalizes the prose, writes a durable link nobody made, and retires
  /// the pending photo suggestion, which sending any description does.
  bool _descriptionEdited = false;

  List<LibraryCharacter> get _loadedCharacters =>
      ref.read(charactersProvider).asData?.value.characters ??
      const <LibraryCharacter>[];

  void _syncDescriptionMentions() {
    if (!mounted) return;
    final text = _descriptionController.text;
    // The controller's own listener, so keystrokes and direct writes alike.
    final overflow = _descriptionOverflowOf(text);
    // **Past the cap this sheet resolves nothing, and only says how far past.**
    // Everything below reads the whole description — one `libraryTextHasMention`
    // sweep per inserted link, then [resolveLibraryMentions] over all of it —
    // and this runs per keystroke. The field is deliberately unenforced (see
    // [CharacterDescriptionField]), so "the whole description" is whatever was
    // pasted into it, and sweeping that again on every character typed after
    // bought nothing: prose over the cap is prose no body can carry — [_save]
    // refuses it whenever the request would send one, and the only save it lets
    // through is one that sends no description at all — so nothing resolved
    // here could travel. A rename is not reached from here at all — it hangs
    // off the library subscription — so prose parked over the cap still
    // follows one, which no amount of shortening would do. The chips stand at
    // whatever the prose last resolved to, since the first keystroke back
    // under the cap re-resolves them; the suggestion strip does not, because
    // [_insertMention] measures the cap first and refuses each pick it offers.
    if (overflow > 0) {
      if (overflow == _descriptionOverflow && _mentionQuery == null) return;
      setState(() {
        _descriptionOverflow = overflow;
        _mentionQuery = null;
      });
      return;
    }
    _insertedMentionTextById.removeWhere(
      (_, mentionText) => !libraryTextHasMention(text, mentionText),
    );
    final selection = _descriptionController.selection;
    final caret = selection.isValid && selection.isCollapsed
        ? selection.baseOffset
        : -1;
    final query = caret < 0 ? null : libraryMentionQueryAt(text, caret);
    final attached = resolveLibraryMentions(
      text: text,
      inserted: _insertedMentionTextById,
      characters: _loadedCharacters,
      excludeCharacterId: _saved?.id,
      // The cap itself: the resolver answers one past whatever it is given, and
      // that sentinel has to stay visible here, because a set trimmed to a
      // legal-looking length is what silently dropped a link the prose still
      // carried on the next save.
      limit: _mentionsMax,
    );
    final changed =
        query?.start != _mentionQuery?.start ||
        query?.query != _mentionQuery?.query ||
        overflow != _descriptionOverflow ||
        !_sameMentions(attached, _attachedMentions);
    if (!changed) return;
    setState(() {
      _mentionQuery = query;
      _attachedMentions = attached;
      _descriptionOverflow = overflow;
    });
  }

  /// Every link the prose is believed to carry, spelled the way the prose
  /// still spells it.
  ///
  /// **Two sources, because neither one is the whole set.**
  /// [_insertedMentionTextById] answers only for links this sheet put in the
  /// prose itself — the ones the character was saved with, plus the chips the
  /// reader tapped. [_attachedMentions] answers for every link the prose
  /// actually resolves to, which is strictly more: a pre-feature description
  /// reading "Inspired by @bram" is resolved by the sheet with no tap and no
  /// stored link, exactly the case [_descriptionEdited] is tracked for, and the
  /// map stays empty for it. Following renames through the map alone left those
  /// tokens spelling a name nobody answers to; the resolver stopped matching
  /// them, the chip went out without a word, and the save wrote prose carrying
  /// an `@marker` bound to nothing — which no later scan can repair, because
  /// nothing downstream knows who it named.
  ///
  /// **The resolved list is behind by one pass, on purpose.** It is only
  /// rewritten at the end of [_syncDescriptionMentions], so while a rename is
  /// being followed it still names each link the way the prose was resolved
  /// under — which is the old spelling the rewrite has to find. Where the map
  /// also knows an id the map wins: [_respellRenamedMentions] updates it as it
  /// rewrites, so the resolve that re-enters through the controller's listener
  /// reads the new spelling there and keeps the link, instead of pruning an
  /// entry the respelled prose no longer spells that way.
  List<LibraryMention> _proseMentionClaimants() {
    final claimants = [
      for (final entry in _insertedMentionTextById.entries)
        LibraryMention(
          id: entry.key,
          name: entry.value.substring(1),
          // Stated, not defaulted. The map carries no kind — it is
          // `id -> '@Name'` — and only character paths write it: the seed above
          // and [_insertMention]. A kind that arrives as a constructor default
          // is one nobody notices going wrong.
          kind: LibraryMentionKind.character,
        ),
    ];
    final claimed = {for (final claimant in claimants) claimant.id};
    for (final mention in _attachedMentions) {
      if (claimed.add(mention.id)) claimants.add(mention);
    }
    return claimants;
  }

  /// Follows a mention target's rename into the prose the reader is holding.
  ///
  /// Renaming a character rewrites every description that links to them, so a
  /// token still spelling the old name is one the save is refused for — and it
  /// is a link the sheet resolved, not prose the reader typed, which is why
  /// respelling it leaves [_descriptionEdited] alone.
  ///
  /// **Asked once per library delivery, from the subscription in [initState],
  /// and nowhere else.** Every name it weighs a claimant against comes off
  /// [_loadedCharacters], so nothing between two deliveries moves its answer,
  /// and a delivery lands before any tap that could save the old spelling. At
  /// the top of [_syncDescriptionMentions] — where it sat, in front of the
  /// over-cap short-circuit meant to stop per-keystroke work — it rebuilt
  /// `namesById` and [_proseMentionClaimants] once per character typed.
  ///
  /// **The whole link set claims, and only the renamed part of it is
  /// rewritten.** The set here is [_proseMentionClaimants]: every link the
  /// prose carries, not the subset this session typed. Claiming with the
  /// renamed subset alone let a short name take a span nested inside a longer
  /// sibling's token: "Friends with @Luna and @Luna Vega." became
  /// "…@Nova and @Nova Vega." here while the server stored
  /// "…@Nova and @Luna Vega.", and the next save of that prose was refused with
  /// "The description no longer contains @Luna Vega." — a save nothing the
  /// reader could type would fix.
  ///
  /// **The shape of that rule is the server's; the set is not.**
  /// `rewriteIncomingLibraryMentions` claims with `claimingNames`, the source's
  /// *stored* CHARACTER rows, while [_proseMentionClaimants] is wider by every
  /// link this sheet resolved out of prose with no stored row — what it exists
  /// for — so the two differ where such a name nests inside another. Stored
  /// links {Luna}, prose "Met @Luna and @Luna Vega." with Luna Vega saved but
  /// unlinked: renaming Luna, the server writes "…@Nova and @Nova Vega." while
  /// this writes "…@Nova and @Luna Vega.". Narrowing to agree would respell a
  /// token naming somebody else, so the wider set stays: an edited Save sends
  /// this prose with both ids and settles it, and a sheet closed unedited sends
  /// nothing, leaving the server's copy standing.
  ///
  /// **A token that lands longer than the one it replaces can cross the
  /// description's cap, and the reader is told when it does.** Nothing enforces
  /// that cap between here and the route, and leaving the old spelling is no
  /// way out — it is the refusal above. So it respells, says why the field is
  /// over, and [_save] holds the body back until it fits: unstopped, that
  /// length comes back from zod as the update route's catch-all "Send at least
  /// one change.", about a change the reader did make for a length they did
  /// not.
  ///
  /// Answers whether the prose moved.
  bool _respellRenamedMentions() {
    final namesById = {
      for (final character in _loadedCharacters) character.id: character.name,
    };
    final claimants = _proseMentionClaimants();
    final renamedIds = <String>{};
    for (final claimant in claimants) {
      final name = namesById[claimant.id];
      if (name != null && name != claimant.name) renamedIds.add(claimant.id);
    }
    if (renamedIds.isEmpty) return false;
    // Every token this is about to rewrite gets its new spelling written down,
    // including one that only ever came out of the prose. The map is what the
    // pass re-entering below reads a spelling out of, so a rewrite that skipped
    // it would leave the prose naming somebody the sheet no longer claims —
    // the same orphan through a second door, and this time one this method
    // opened itself.
    for (final id in renamedIds) {
      _insertedMentionTextById[id] = '@${namesById[id]}';
    }

    var text = _descriptionController.text;
    final selection = _descriptionController.selection;
    // Both ends of the selection travel through the same shift, so a reader
    // part-way through selecting a phrase when the poll lands keeps it.
    var base = selection.isValid ? selection.baseOffset : -1;
    var extent = selection.isValid ? selection.extentOffset : -1;
    // Right to left, so every span that has not been rewritten yet still sits
    // at the offset it was claimed at.
    final ranges = [
      for (final range in savedLibraryMentionRanges(text, claimants))
        if (renamedIds.contains(range.mention.id)) range,
    ].reversed;
    for (final range in ranges) {
      final token = '@${namesById[range.mention.id]}';
      text = text.replaceRange(range.start, range.end, token);
      final shift = token.length - (range.end - range.start);
      base = _shiftedOffset(base, range.start, shift, text.length);
      extent = _shiftedOffset(extent, range.start, shift, text.length);
    }
    if (text == _descriptionController.text) return false;
    final wasOver = _overDescriptionLimit(_descriptionController.text);
    _descriptionController.value = TextEditingValue(
      text: text,
      selection: base < 0 || extent < 0
          ? const TextSelection.collapsed(offset: -1)
          : TextSelection(baseOffset: base, extentOffset: extent),
    );
    // Once per rename: the tokens are respelled above, so the next poll finds
    // nothing renamed and the field's own error carries it from here.
    if (!wasOver && _overDescriptionLimit(text)) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(
          content: Text(
            'A character you mentioned was renamed and the description is now '
            'too long. Shorten it to save.',
          ),
        ),
      );
    }
    return true;
  }

  /// Where an offset lands once the token starting at [start] has changed
  /// length by [shift].
  ///
  /// `-1` is the field's own "no selection" sentinel rather than a position, so
  /// it comes back untouched: writing it into a collapsed caret is how a reader
  /// who had a phrase selected lost the phrase *and* the cursor to a rename
  /// arriving three seconds later.
  static int _shiftedOffset(int offset, int start, int shift, int length) =>
      offset <= start ? offset : (offset + shift).clamp(start, length);

  /// One positional walk over both lists, pairing them off under [same].
  ///
  /// The two questions below stay two — different pairs of lists, different
  /// owners — but the walk is one, so a field that starts mattering to a link
  /// lands in the predicate that owns it and nowhere else.
  /// [LibraryMention.otherType] is the next of them, the day OTHER rows reach
  /// this sheet: beside the name, which a chip draws, and not with the ids,
  /// which are all a save sends. Across two walks it is a field to remember
  /// twice — which is how the chips came to be compared by id alone.
  static bool _sameMentionsBy(
    List<LibraryMention> left,
    List<LibraryMention> right,
    bool Function(LibraryMention a, LibraryMention b) same,
  ) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index++) {
      if (!same(left[index], right[index])) return false;
    }
    return true;
  }

  /// Whether the same links are attached. Only ids travel, so this is the
  /// question a save asks: a name the library has moved on from underneath the
  /// sheet is not a link the reader touched, and writing the cast back over it
  /// is a request nobody asked for.
  bool _sameMentionIds(List<LibraryMention> left, List<LibraryMention> right) =>
      _sameMentionsBy(left, right, (a, b) => a.id == b.id);

  /// Whether the same links are attached *and named the same way*. What the
  /// chips are drawn from, so an id-only comparison left them reading a name
  /// the library had already moved on from. Still one walk rather than
  /// [_sameMentionIds] plus a second over the same list: every keystroke asks.
  bool _sameMentions(List<LibraryMention> left, List<LibraryMention> right) =>
      _sameMentionsBy(
        left,
        right,
        (a, b) => a.id == b.id && a.name == b.name && a.kind == b.kind,
      );

  void _insertMention(LibraryCharacter character) {
    final query = _mentionQuery;
    if (query == null) return;
    final text = _descriptionController.text;
    final selection = _descriptionController.selection;
    final caret = selection.isValid && selection.isCollapsed
        ? selection.baseOffset
        : text.length;
    final mentionText = '@${character.name}';
    final replacement = '$mentionText ';
    final inserted =
        text.substring(0, query.start) + replacement + text.substring(caret);
    // Nothing enforces the cap, so without this the chip pushes the description
    // past it and the save comes back as the route's generic message with
    // nothing on screen explaining it. Measured as [_save] would send it.
    if (_overDescriptionLimit(inserted)) {
      _refuseMention('That would make the description too long.');
      return;
    }
    // The limit belongs to the set of distinct characters, so a second
    // occurrence of one already attached is not a new mention.
    if (_attachedMentions.length >= _mentionsMax &&
        !_attachedMentions.any((mention) => mention.id == character.id)) {
      _refuseMention(
        'A description can mention up to $_mentionsMax characters.',
      );
      return;
    }
    _descriptionEdited = true;
    _insertedMentionTextById[character.id] = mentionText;
    _descriptionController.value = TextEditingValue(
      text: inserted,
      selection: TextSelection.collapsed(
        offset: query.start + replacement.length,
      ),
    );
  }

  /// Says why an insertion was refused, having changed nothing: the text and
  /// the half-typed `@token` are left exactly as the reader had them, so a
  /// silent refusal would look like a tap that missed.
  void _refuseMention(String message) {
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(message)));
  }

  /// How far [text] is past the description's cap; 0 while it fits. The
  /// measurement, and why it is the trimmed string, live with the field that
  /// draws the counter — [characterDescriptionOverflow].
  int _descriptionOverflowOf(String text) =>
      characterDescriptionOverflow(text, _descriptionMax);

  bool _overDescriptionLimit(String text) => _descriptionOverflowOf(text) > 0;

  Widget _mentionSuggestions(LibraryMentionQuery query) {
    final library = ref.watch(charactersProvider);
    final needle = query.query.trim().toLowerCase();
    final matches = [
      for (final character
          in library.asData?.value.characters ?? const <LibraryCharacter>[])
        if (character.id != _saved?.id &&
            (needle.isEmpty || character.name.toLowerCase().contains(needle)))
          character,
    ];
    return SizedBox(
      height: 44,
      child: ListView.separated(
        key: const ValueKey('character-mention-suggestions'),
        scrollDirection: Axis.horizontal,
        itemCount: matches.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final character = matches[index];
          return ActionChip(
            avatar: const Icon(Icons.person_outline, size: 16),
            label: Text(character.name),
            onPressed: _busy ? null : () => _insertMention(character),
          );
        },
      ),
    );
  }
}
