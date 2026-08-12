part of 'creation_chat_screen.dart';

// @-mentions for library characters, shared by both chat stages: the same
// composer serves the creation chat and the finished-book chat, so one
// detector and one suggestion strip cover both. Mention state is derived from
// the composer text alone — clearing the composer clears the mentions, and an
// @Name deleted by hand stops being a mention without extra bookkeeping.

/// An `@token` being typed at the caret: `start` is the index of the `@`.
class _MentionQuery {
  const _MentionQuery({required this.start, required this.query});

  final int start;
  final String query;
}

mixin _ComposerMentions on ConsumerState<CreationChatScreen> {
  TextEditingController get _composerController;
  FocusNode get _composerFocusNode;
  void _updateState(VoidCallback update);

  /// Characters inserted through the strip, id → the exact `@Name` text used.
  /// Only ids whose text still appears in the composer are ever sent.
  final Map<String, String> _insertedMentionTextById = <String, String>{};
  _MentionQuery? _mentionQuery;

  void _attachMentionListener() {
    _composerController.addListener(_syncMentionsFromComposer);
  }

  void _detachMentionListener() {
    _composerController.removeListener(_syncMentionsFromComposer);
  }

  void _syncMentionsFromComposer() {
    if (!mounted) return;
    final text = _composerController.text;
    _insertedMentionTextById.removeWhere(
      (_, mentionText) => !_textHasMention(text, mentionText),
    );
    final selection = _composerController.selection;
    final caret = selection.isValid && selection.isCollapsed
        ? selection.baseOffset
        : -1;
    final query = caret < 0 ? null : _mentionQueryAt(text, caret);
    if (query?.start != _mentionQuery?.start ||
        query?.query != _mentionQuery?.query) {
      _updateState(() => _mentionQuery = query);
    }
  }

  /// The ids to send with [text]: every strip-inserted mention whose `@Name`
  /// is still present. Pure read — clearing happens through the composer.
  List<String> _mentionedCharacterIdsFor(String text) {
    return [
      for (final entry in _insertedMentionTextById.entries)
        if (_textHasMention(text, entry.value)) entry.key,
    ];
  }

  void _insertMention(LibraryCharacter character) {
    final query = _mentionQuery;
    if (query == null) return;
    final text = _composerController.text;
    final selection = _composerController.selection;
    final caret = selection.isValid && selection.isCollapsed
        ? selection.baseOffset
        : text.length;
    final mentionText = '@${character.name}';
    final replaced = '$mentionText ';
    final next =
        text.substring(0, query.start) + replaced + text.substring(caret);
    _insertedMentionTextById[character.id] = mentionText;
    _composerController.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(
        offset: query.start + replaced.length,
      ),
    );
    _composerFocusNode.requestFocus();
  }

  void _resetMentions() {
    _insertedMentionTextById.clear();
    _mentionQuery = null;
  }

  Future<void> _openCharacterLibrary() async {
    _updateState(() => _mentionQuery = null);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => const CharacterLibraryScreen()),
    );
  }
}

/// Whether [mentionText] (`@Name`) occurs in [text] as a whole mention, not as
/// a prefix of a longer one — `@Sam` inside `@Samantha` does not count, or a
/// deleted short mention would ride along on its longer sibling forever.
bool _textHasMention(String text, String mentionText) {
  var index = text.indexOf(mentionText);
  while (index != -1) {
    final end = index + mentionText.length;
    if (end >= text.length || !_isNameCharacter(text[end])) return true;
    index = text.indexOf(mentionText, index + 1);
  }
  return false;
}

final _nameCharacter = RegExp(r'[\p{L}\p{N}]', unicode: true);

bool _isNameCharacter(String character) => _nameCharacter.hasMatch(character);

/// The `@token` at [caret], or null when the caret is not inside one. The `@`
/// must open a word (start of text or after whitespace) and the token must be
/// short and single-line, so ordinary email addresses never trigger the strip.
_MentionQuery? _mentionQueryAt(String text, int caret) {
  if (caret < 0 || caret > text.length) return null;
  final upToCaret = text.substring(0, caret);
  final at = upToCaret.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !_isMentionBoundary(upToCaret[at - 1])) return null;
  final query = upToCaret.substring(at + 1);
  if (query.length > 40 || query.contains('\n') || query.contains('@')) {
    return null;
  }
  return _MentionQuery(start: at, query: query);
}

/// Whitespace plus the zero-width joiners and directional marks Persian and
/// other RTL keyboards insert — an `@` after a ZWNJ still opens the strip.
bool _isMentionBoundary(String character) {
  if (character.trim().isEmpty) return true;
  return const {'‌', '‍', '‎', '‏'}.contains(character);
}

/// Horizontal strip of matching library characters, shown while an `@token`
/// is being typed. Rendered above whichever footer is active.
class _MentionSuggestionStrip extends ConsumerWidget {
  const _MentionSuggestionStrip({
    required this.query,
    required this.onSelect,
    required this.onManage,
  });

  final String query;
  final ValueChanged<LibraryCharacter> onSelect;
  final VoidCallback onManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final library = ref.watch(charactersProvider);
    final characters =
        library.asData?.value.characters ?? const <LibraryCharacter>[];
    final needle = query.trim().toLowerCase();
    final matches = [
      for (final character in characters)
        if (needle.isEmpty ||
            character.name.toLowerCase().contains(needle))
          character,
    ];
    // While the library is still loading, "Create a character" would lie to a
    // user who has a full one — show a quiet placeholder instead.
    final loading = library.isLoading && characters.isEmpty;
    return Material(
      color: colors.surface,
      child: SizedBox(
        height: 52,
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
                  matches.isEmpty ? Icons.person_add_alt : Icons.people_outline,
                  size: 18,
                ),
                label: Text(
                  matches.isEmpty ? 'Create a character' : 'My characters',
                ),
                onPressed: onManage,
              ),
          ],
        ),
      ),
    );
  }
}
