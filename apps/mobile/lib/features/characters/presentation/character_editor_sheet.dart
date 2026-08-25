import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';
import '../domain/library_mentions.dart';
import 'character_editor_fields.dart';

part 'character_editor_mentions.dart';

/// Creates or edits one library character.
///
/// The form and nothing else. Pictures used to live in here too, behind a
/// character that had to be saved first — which is how a sheet titled "New
/// character" silently became an "Edit character" sheet mid-life. They have
/// their own page now, and this answers with the character it wrote so the
/// caller can open it.
Future<LibraryCharacter?> showCharacterEditorSheet(
  BuildContext context, {
  LibraryCharacter? character,
}) {
  return showAppBottomSheet<LibraryCharacter>(
    context,
    builder: (_) => _CharacterEditorSheet(character: character),
  );
}

// Mirrors apps/api/src/mobile/characterSchemas.ts.
const _nameMax = 80;
const _descriptionMax = 2000;
const _fieldsMax = 12;
const _fieldKeyMax = 40;
const _fieldValueMax = 300;
const _mentionsMax = 10;

const _suggestedFieldKeys = ['Age', 'Job', 'Languages', 'Personality', 'Likes'];

class _CharacterEditorSheet extends ConsumerStatefulWidget {
  const _CharacterEditorSheet({required this.character});

  final LibraryCharacter? character;

  @override
  ConsumerState<_CharacterEditorSheet> createState() =>
      _CharacterEditorSheetState();
}

class _CharacterEditorSheetState extends ConsumerState<_CharacterEditorSheet>
    with _CharacterEditorMentions {
  late final _nameController = TextEditingController(
    text: widget.character?.name ?? '',
  );
  @override
  late final TextEditingController _descriptionController =
      TextEditingController(text: widget.character?.description ?? '');
  late final List<CharacterDetailRow> _fields = [
    for (final field in widget.character?.fields ?? const <CharacterField>[])
      CharacterDetailRow(key: field.key, value: field.value),
  ];

  ProviderSubscription<AsyncValue<CharacterLibrary>>? _characterLibraryWatch;

  /// Rows taken out of [_fields] stay alive until the sheet closes: their
  /// text fields may still be animating out when they are removed.
  final List<CharacterDetailRow> _removedFields = [];

  /// The character as the server last confirmed it. Null until a new character
  /// is created; the photo and portrait sections need an id to talk about.
  @override
  late LibraryCharacter? _saved = widget.character;

  bool _saving = false;
  bool _suggestionBusy = false;
  String? _nameError;

  /// Set the moment the reader taps "Use this", so the card goes away without
  /// waiting for the PATCH that retires it server-side — which only happens
  /// when they save.
  bool _suggestionTaken = false;

  @override
  void initState() {
    super.initState();
    _descriptionOverflow = _descriptionOverflowOf(_descriptionController.text);
    _descriptionController.addListener(_syncDescriptionMentions);
    _characterLibraryWatch = ref.listenManual(charactersProvider, (_, next) {
      if (!mounted || !next.hasValue) return;
      // Both halves of a delivery. A rename it carries is followed here and
      // nowhere else ([_respellRenamedMentions] holds why); a respell writes
      // the field, so the resolve re-enters through the controller's listener
      // and the call below is for the delivery that respelled nothing — a name
      // typed while the library request was still in flight, resolved now.
      if (!_respellRenamedMentions()) _syncDescriptionMentions();
    });
  }

  @override
  void dispose() {
    _characterLibraryWatch?.close();
    _nameController.dispose();
    _descriptionController.dispose();
    for (final row in _fields) {
      row.dispose();
    }
    for (final row in _removedFields) {
      row.dispose();
    }
    super.dispose();
  }

  @override
  bool get _busy => _saving || _suggestionBusy;

  /// The description read off the photo, while it is still on offer.
  String? get _suggestion {
    if (_suggestionTaken) return null;
    final suggestion = _saved?.suggestedDescription?.trim();
    if (suggestion == null || suggestion.isEmpty) return null;
    // Already what they have; offering it back would be noise.
    return suggestion == _descriptionController.text.trim() ? null : suggestion;
  }

  bool _hasFieldKey(String key) {
    final lower = key.toLowerCase();
    return _fields.any((row) => row.key.text.trim().toLowerCase() == lower);
  }

  void _addField({String key = ''}) {
    if (_fields.length >= _fieldsMax) return;
    setState(() => _fields.add(CharacterDetailRow(key: key)));
  }

  void _removeField(CharacterDetailRow row) {
    setState(() {
      _fields.remove(row);
      _removedFields.add(row);
    });
  }

  /// Trimmed rows ready to send, or null after telling the user about a row
  /// that is only half filled — dropping typed text silently is worse than
  /// asking.
  List<CharacterField>? _collectFields() {
    final collected = <CharacterField>[];
    for (final row in _fields) {
      final key = row.key.text.trim();
      final value = row.value.text.trim();
      if (key.isEmpty && value.isEmpty) continue;
      if (key.isEmpty || value.isEmpty) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          const SnackBar(
            content: Text('Each detail needs both a label and a value.'),
          ),
        );
        return null;
      }
      collected.add(CharacterField(key: key, value: value));
    }
    return collected;
  }

  bool _sameFields(List<CharacterField> a, List<CharacterField> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].key != b[i].key || a[i].value != b[i].value) return false;
    }
    return true;
  }

  Future<void> _save() async {
    final messenger = ScaffoldMessenger.of(context);
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _nameError = 'Give the character a name.');
      return;
    }
    final fields = _collectFields();
    if (fields == null) return;
    final description = _descriptionController.text.trim();
    final saved = _saved;
    final mentionIds = [for (final mention in _attachedMentions) mention.id];

    String? changedName;
    String? changedDescription;
    List<CharacterField>? changedFields;
    List<String>? changedMentions;
    if (saved != null) {
      changedName = name != saved.name ? name : null;
      changedFields = _sameFields(fields, saved.fields) ? null : fields;
      // Only what the reader did to the description counts. Everything the
      // sheet resolved on its own — see [_descriptionEdited] — leaves this an
      // unchanged form, and an unchanged form pops without a request.
      if (_descriptionEdited) {
        changedDescription = description != saved.description
            ? description
            : null;
        // Against the cast, not the whole stored list. A link into another
        // library is one this sheet neither resolves nor sends, so a row of
        // that kind sitting in `mentions` is not a change the reader made —
        // compared against the wider list it read as one on every save, and
        // sent a link write nobody asked for.
        changedMentions =
            _sameMentionIds(_attachedMentions, saved.characterMentions)
            ? null
            : mentionIds;
      }
      if (changedName == null &&
          changedDescription == null &&
          changedFields == null &&
          changedMentions == null) {
        Navigator.of(context).pop();
        return;
      }
    }
    // The body carries the description exactly when it carries the link set: a
    // mention-set change sends the prose it was resolved from, and a create
    // sends both. One predicate for both refusals below — and a body that
    // carries neither is held back by neither.
    final sendsDescription =
        saved == null || changedDescription != null || changedMentions != null;
    // Nothing between the field and the route enforces this cap — see
    // [_descriptionOverflow] — so here is the last place it can be stopped
    // while it is still something the reader can be shown. It counts
    // [description], the string the body carries, which is what the counter on
    // screen counts too: one measurement, or the two disagree in whitespace.
    if (sendsDescription && _overDescriptionLimit(description)) {
      messenger.showAppSnackBar(
        const SnackBar(
          content: Text(
            'The description is too long. Shorten it and save again.',
          ),
        ),
      );
      return;
    }
    // The route refuses more than this, and the alternative to saying so is
    // sending a set quietly cut down to the cap — which deletes a link the
    // reader can still see in their own prose.
    if (sendsDescription && mentionIds.length > _mentionsMax) {
      messenger.showAppSnackBar(
        SnackBar(
          content: Text(
            'A description can mention up to $_mentionsMax characters. '
            'Remove a few @names and save again.',
          ),
        ),
      );
      return;
    }

    setState(() {
      _saving = true;
      _nameError = null;
    });
    try {
      if (saved == null) {
        final created = await ref
            .read(charactersRepositoryProvider)
            .create(
              name: name,
              description: description,
              fields: fields,
              mentionedCharacterIds: mentionIds,
            );
        if (!mounted) return;
        ref.invalidate(charactersProvider);
        // Closes and hands the character back: their page is where a face gets
        // added, so staying open with newly-unlocked sections was a waypoint.
        Navigator.of(context).pop(created);
      } else {
        final updated = await ref
            .read(charactersRepositoryProvider)
            .update(
              id: saved.id,
              name: changedName,
              // A mention-set change is meaningful even when the prose itself
              // did not change, so send the current description with that set.
              description:
                  changedDescription ??
                  (changedMentions != null ? description : null),
              fields: changedFields,
              mentionedCharacterIds:
                  changedDescription != null || changedMentions != null
                  ? mentionIds
                  : null,
            );
        if (!mounted) return;
        ref.invalidate(charactersProvider);
        Navigator.of(context).pop(updated);
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        if (error.code == 'CHARACTER_NAME_TAKEN') {
          _nameError = error.message;
        }
      });
      if (error.code != 'CHARACTER_NAME_TAKEN') {
        messenger.showAppSnackBar(SnackBar(content: Text(error.message)));
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    }
  }

  /// Accepting a suggestion only fills the field. Nothing is sent: the reader
  /// can still edit it, and Save carries it like anything else they typed.
  void _useSuggestion(String suggestion) {
    setState(() {
      _descriptionController.text = suggestion;
      // Setting the text this way runs no `onChanged`, and taking the offer is
      // as much the reader's edit as typing it would have been.
      _descriptionEdited = true;
      _suggestionTaken = true;
    });
  }

  Future<void> _dismissSuggestion() async {
    final saved = _saved;
    if (saved == null || _busy) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _suggestionTaken = true;
      _suggestionBusy = true;
    });
    try {
      final updated = await ref
          .read(charactersRepositoryProvider)
          .update(id: saved.id, dismissSuggestion: true);
      if (!mounted) return;
      ref.invalidate(charactersProvider);
      setState(() {
        _saved = updated;
        _suggestionBusy = false;
      });
    } catch (error) {
      if (!mounted) return;
      // The card is already gone locally; putting it back to report a failed
      // dismissal would be the opposite of what was asked for.
      setState(() => _suggestionBusy = false);
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    // Background polling can move this row underneath the form; adopt the new
    // one without clobbering anything the reader is part-way through typing.
    // Mentions are not re-resolved here: the subscription opened in `initState`
    // already answers the same notification, and running both meant a second
    // pass over the whole description every three seconds for the sheet's life.
    ref.listen(charactersProvider, (previous, next) {
      final saved = _saved;
      final characters = next.value?.characters;
      if (saved == null || characters == null) return;
      for (final character in characters) {
        if (character.id == saved.id) {
          if (!identical(character, saved)) setState(() => _saved = character);
          return;
        }
      }
    });

    final theme = Theme.of(context);
    final creating = _saved == null;
    final suggestion = _suggestion;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.88,
        ),
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            18,
            4,
            18,
            18 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                creating ? 'New character' : 'Edit character',
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Saved characters can be written and drawn consistently across '
                'every book you make.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _nameController,
                maxLength: _nameMax,
                textCapitalization: TextCapitalization.words,
                decoration: InputDecoration(
                  labelText: 'Name',
                  counterText: '',
                  errorText: _nameError,
                ),
                onChanged: (_) {
                  if (_nameError != null) setState(() => _nameError = null);
                },
              ),
              const SizedBox(height: 12),
              CharacterDescriptionField(
                controller: _descriptionController,
                max: _descriptionMax,
                overflow: _descriptionOverflow,
                onChanged: () => _descriptionEdited = true,
              ),
              if (_mentionQuery != null) ...[
                const SizedBox(height: 8),
                _mentionSuggestions(_mentionQuery!),
              ],
              if (_attachedMentions.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  key: const ValueKey('character-description-mentions'),
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final mention in _attachedMentions)
                      Chip(
                        avatar: const Icon(Icons.person_outline, size: 16),
                        label: Text('@${mention.name}'),
                      ),
                  ],
                ),
              ],
              if (suggestion != null) ...[
                const SizedBox(height: 12),
                CharacterSuggestionCard(
                  suggestion: suggestion,
                  onUse: _busy ? null : () => _useSuggestion(suggestion),
                  onDismiss: _busy ? null : _dismissSuggestion,
                ),
              ],
              const SizedBox(height: 16),
              Text(
                'Details',
                style: theme.textTheme.labelMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 8),
              for (final row in _fields)
                CharacterDetailRowField(
                  row: row,
                  keyMax: _fieldKeyMax,
                  valueMax: _fieldValueMax,
                  onRemove: () => _removeField(row),
                ),
              Wrap(
                spacing: 8,
                children: [
                  for (final key in _suggestedFieldKeys)
                    if (!_hasFieldKey(key))
                      ActionChip(
                        label: Text(key),
                        onPressed: _fields.length >= _fieldsMax
                            ? null
                            : () => _addField(key: key),
                      ),
                  ActionChip(
                    label: const Text('Add detail'),
                    avatar: const Icon(Icons.add, size: 16),
                    onPressed: _fields.length >= _fieldsMax ? null : _addField,
                  ),
                ],
              ),
              const SizedBox(height: 20),
              AppButton.primary(
                key: const ValueKey('character-editor-save'),
                label: creating ? 'Create character' : 'Save changes',
                loading: _saving,
                expanded: true,
                onPressed: _busy ? null : _save,
              ),
            ],
          ),
        ),
      ),
    );
  }

}
