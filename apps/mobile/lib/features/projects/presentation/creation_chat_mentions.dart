part of 'creation_chat_screen.dart';

// @-mentions for library characters, shared by both chat stages: the same
// composer serves the creation chat and the finished-book chat, so one
// detector and one suggestion strip cover both. Mention state is derived from
// the composer text alone — clearing the composer clears the mentions, and an
// @Name deleted by hand stops being a mention without extra bookkeeping.
//
// "Derived from the text" is the whole rule, and it used to hold only for the
// half the strip inserted: the ids sent with a message came from a map written
// by `_insertMention` and nothing else, so a reader who typed `@Luna` by hand —
// or who changed the case of an inserted one — sent no id at all and the book
// invented a character wearing that name. The composer text is now scanned
// against the loaded library too, so a mention is a mention however it got
// typed, and the two sources are unioned rather than ranked.

/// An `@token` being typed at the caret: `start` is the index of the `@`.
class _MentionQuery {
  const _MentionQuery({required this.start, required this.query});

  final int start;
  final String query;
}

/// How many mentions one message may carry.
///
/// The API caps `mentionedCharacterIds` at ten and rejects the whole send with
/// a 400 past that, so an eleventh mention has to be dropped here — losing one
/// character is recoverable, losing the message is not.
const _maxMentionsPerMessage = 10;

mixin _ComposerMentions on ConsumerState<CreationChatScreen> {
  TextEditingController get _composerController;
  FocusNode get _composerFocusNode;
  void _updateState(VoidCallback update);

  /// Characters inserted through the strip or rehydrated from a message being
  /// edited, id → the exact `@Name` text used. Only ids whose text still
  /// appears in the composer are ever sent.
  final Map<String, String> _insertedMentionTextById = <String, String>{};
  _MentionQuery? _mentionQuery;
  bool _composerHasFocus = false;

  /// What the message would be sent with right now, in the order the text
  /// names them — what the `MentionChipsRow` above the composer draws, so what
  /// the send puts on the wire and what the reader can see never disagree.
  ///
  /// The same `{id, name}` shape a stored message carries, because it is the
  /// same fact: this is the message's mention list before it has been sent.
  List<MobileCreationCharacterRef> _attachedMentions =
      const <MobileCreationCharacterRef>[];

  /// Holds the (autoDispose) library open while the composer is talking about
  /// characters. A bare `ref.read` at send time would start a fetch and drop it
  /// in the same breath, so a typed `@Luna` would resolve against an empty list
  /// forever; a subscription keeps the loaded list between keystrokes and tells
  /// us when it arrives.
  ProviderSubscription<AsyncValue<CharacterLibrary>>? _characterLibraryWatch;

  void _attachMentionListener() {
    _composerController.addListener(_syncMentionsFromComposer);
    _composerFocusNode.addListener(_syncMentionsFromComposer);
  }

  void _detachMentionListener() {
    _composerController.removeListener(_syncMentionsFromComposer);
    _composerFocusNode.removeListener(_syncMentionsFromComposer);
    _characterLibraryWatch?.close();
    _characterLibraryWatch = null;
  }

  void _syncMentionsFromComposer() {
    if (!mounted) return;
    final text = _composerController.text;
    _watchCharacterLibraryFor(text);
    _insertedMentionTextById.removeWhere(
      (_, mentionText) => !_textHasMention(text, mentionText),
    );
    final selection = _composerController.selection;
    final caret = selection.isValid && selection.isCollapsed
        ? selection.baseOffset
        : -1;
    final attached = _resolveMentions(text);
    final typedQuery = caret < 0 ? null : _mentionQueryAt(text, caret);
    final query =
        typedQuery != null && _isCompletedMentionQuery(typedQuery, attached)
        ? null
        : typedQuery;
    final hasFocus = _composerFocusNode.hasFocus;
    final queryChanged =
        query?.start != _mentionQuery?.start ||
        query?.query != _mentionQuery?.query;
    final attachedChanged = !listEquals(
      [for (final mention in attached) mention.id],
      [for (final mention in _attachedMentions) mention.id],
    );
    if (queryChanged || attachedChanged || hasFocus != _composerHasFocus) {
      _updateState(() {
        _mentionQuery = query;
        _attachedMentions = attached;
        _composerHasFocus = hasFocus;
      });
    }
  }

  /// Fetch once the reader starts composing, then keep the library between
  /// keystrokes. Programmatically restored @mentions also need to resolve
  /// before the field receives focus.
  void _watchCharacterLibraryFor(String text) {
    if (_characterLibraryWatch != null ||
        (!_composerFocusNode.hasFocus && !text.contains('@'))) {
      return;
    }
    _characterLibraryWatch = ref.listenManual(charactersProvider, (_, _) {
      // A name typed before the list arrived resolves the moment it does.
      if (mounted) _syncMentionsFromComposer();
    });
  }

  /// Read through [_characterLibraryWatch], never `ref.read`: the provider is
  /// autoDispose, so a read with nothing subscribed created it, fetched the
  /// library and dropped it again — once per keystroke, since every keystroke
  /// resolves mentions. Typing a 150-character brief sent 150 requests. No
  /// subscription means the reader has not started composing yet.
  List<LibraryCharacter> get _loadedCharacters =>
      _characterLibraryWatch?.read().asData?.value.characters ??
      const <LibraryCharacter>[];

  /// The ids to send with [text].
  ///
  /// Pure read — clearing happens through the composer. The text is the send's
  /// own (trimmed) copy rather than the composer's, because the composer is
  /// cleared first on some paths.
  List<String> _mentionedCharacterIdsFor(String text) {
    return [for (final mention in _resolveMentions(text)) mention.id];
  }

  /// Every library character [text] names, from either source.
  List<MobileCreationCharacterRef> _resolveMentions(String text) {
    return _resolveComposerMentions(
      text: text,
      inserted: _insertedMentionTextById,
      characters: _loadedCharacters,
    );
  }

  /// After a complete name and a space, the reader is writing prose again.
  /// A typed prefix may still extend to a longer saved name; a tapped pick is
  /// already complete even when another character shares that prefix.
  bool _isCompletedMentionQuery(
    _MentionQuery query,
    List<MobileCreationCharacterRef> attached,
  ) {
    final typed = query.query.toLowerCase();
    for (final mention in attached) {
      if (!typed.startsWith('${mention.name.toLowerCase()} ')) continue;
      if (_insertedMentionTextById.containsKey(mention.id) ||
          !_loadedCharacters.any(
            (character) => character.name.toLowerCase().startsWith(typed),
          )) {
        return true;
      }
    }
    return false;
  }

  void _insertMention(LibraryCharacter character) {
    final query = _mentionQuery;
    final text = _composerController.text;
    final selection = _composerController.selection;
    final start =
        query?.start ?? (selection.isValid ? selection.start : text.length);
    final end = selection.isValid ? selection.end : text.length;
    final before = text.substring(0, start);
    final after = text.substring(end);
    final mentionText = '@${character.name}';
    final leadingSpace = before.isNotEmpty && !RegExp(r'\s$').hasMatch(before)
        ? ' '
        : '';
    final trailingSpace = after.isEmpty || !RegExp(r'^\s').hasMatch(after)
        ? ' '
        : '';
    final replaced = '$leadingSpace$mentionText$trailingSpace';
    final next = before + replaced + after;
    _insertedMentionTextById[character.id] = mentionText;
    _composerController.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + replaced.length),
    );
    _composerFocusNode.requestFocus();
  }

  /// Replaces the picked-mention map: the mentions a stored message was sent
  /// with, before its text is loaded into the composer for an edit — or none
  /// at all, which is what resetting the composer means.
  ///
  /// Without this an edit re-sent the same sentence with no mentions at all:
  /// the `@Luna` is still in the text, but the map that named her was only ever
  /// written by a tap on the strip. Seeding it hands the existing listener the
  /// right semantics for free — a mention the reader deletes while editing
  /// drops out, one they leave in is re-sent.
  ///
  /// Call order matters: assigning `_composerController.text` fires the
  /// listener, which prunes anything the text no longer contains.
  void _seedMentionsFrom(Iterable<MobileCreationCharacterRef> characters) {
    _insertedMentionTextById
      ..clear()
      ..addEntries(
        characters.map(
          (character) => MapEntry(character.id, '@${character.name}'),
        ),
      );
  }

  void _resetMentions() {
    _seedMentionsFrom(const <MobileCreationCharacterRef>[]);
    _attachedMentions = const <MobileCreationCharacterRef>[];
    _mentionQuery = null;
  }

  /// Types the `@` for the reader, so the suggestion strip opens on their saved
  /// characters. The welcome offers this as a tip; the same strip and the same
  /// listener take it from there.
  void _beginMention() {
    final text = _composerController.text;
    final needsSpace =
        text.isNotEmpty && !text.endsWith(' ') && !text.endsWith('\n');
    final next = '${needsSpace ? '$text ' : text}@';
    _composerController.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
    _composerFocusNode.requestFocus();
  }

  Future<void> _openCharacterLibrary() async {
    _updateState(() => _mentionQuery = null);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => const CharacterLibraryScreen()),
    );
  }
}

/// Resolves the characters [text] mentions, unioning the ones picked off the
/// suggestion strip with the ones typed by hand.
///
/// Longest name first, so `@Luna` inside `@Luna Vega` binds the longer name and
/// not both; a name two characters share binds neither, because guessing which
/// one the reader meant is how the wrong face ends up in the book. Ties go to
/// an inserted mention, whose id was chosen rather than inferred.
List<MobileCreationCharacterRef> _resolveComposerMentions({
  required String text,
  required Map<String, String> inserted,
  required List<LibraryCharacter> characters,
}) {
  // The resolver returns one past `limit` so callers can see an over-full
  // set; this caller is the one that drops (see _maxMentionsPerMessage).
  return [
    for (final mention in resolveLibraryMentions(
      text: text,
      inserted: inserted,
      characters: characters,
      limit: _maxMentionsPerMessage,
    ).take(_maxMentionsPerMessage))
      MobileCreationCharacterRef(id: mention.id, name: mention.name),
  ];
}

/// Whether [mentionText] (`@Name`) occurs in [text] as a whole mention.
///
/// Case-insensitive: an inserted `@Luna` the reader lowercased to `@luna` is
/// still that reader's pick, and dropping it silently was half of how a
/// mention went missing.
bool _textHasMention(String text, String mentionText) {
  return libraryTextHasMention(text, mentionText);
}

/// The `token` at [caret], or null when the caret is not inside one. The `@`
/// must open a word (start of text or after non-name punctuation) and the token
/// must be short and single-line, so ordinary email addresses never trigger it.
_MentionQuery? _mentionQueryAt(String text, int caret) {
  final query = libraryMentionQueryAt(text, caret);
  return query == null
      ? null
      : _MentionQuery(start: query.start, query: query.query);
}

/// Available saved characters while composing, optionally filtered by an
/// unfinished @mention. Rendered above whichever footer is active.
class _MentionSuggestionStrip extends ConsumerWidget {
  const _MentionSuggestionStrip({
    required this.query,
    required this.onSelect,
    required this.onManage,
  });

  final String? query;
  final ValueChanged<LibraryCharacter> onSelect;
  final VoidCallback onManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final library = ref.watch(charactersProvider);
    final characters =
        library.asData?.value.characters ?? const <LibraryCharacter>[];
    if (characters.isEmpty && query == null) {
      return const SizedBox.shrink();
    }
    final needle = query?.trim().toLowerCase() ?? '';
    final matches = [
      for (final character in characters)
        if (needle.isEmpty || character.name.toLowerCase().contains(needle))
          character,
    ];
    // While the library is still loading, "Create a character" would lie to a
    // user who has a full one — show a quiet placeholder instead.
    final loading = library.isLoading && characters.isEmpty;
    return Material(
      color: colors.surface,
      child: SizedBox(
        height: math.max(52, MediaQuery.textScalerOf(context).scale(24) + 28),
        child: ListView(
          key: const ValueKey('mention-suggestion-strip'),
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          children: [
            for (final character in matches) ...[
              ActionChip(
                avatar: CharacterAvatar(character: character, radius: 12),
                label: Text(character.name),
                onPressed: () => onSelect(character),
              ),
              const SizedBox(width: 8),
            ],
            if (loading)
              const ActionChip(
                avatar: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                label: Text('Characters…'),
                onPressed: null,
              )
            else
              ActionChip(
                avatar: Icon(
                  characters.isEmpty
                      ? Icons.person_add_alt
                      : Icons.people_outline,
                  size: 18,
                ),
                label: Text(
                  characters.isEmpty ? 'Create a character' : 'My characters',
                ),
                onPressed: onManage,
              ),
          ],
        ),
      ),
    );
  }
}
