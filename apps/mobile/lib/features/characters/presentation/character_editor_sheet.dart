import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';
import '../domain/library_mentions.dart';
import 'character_editor_fields.dart';
import 'character_editor_layout.dart';

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
    // Flutter's drag dismissal pops directly, bypassing PopScope. Keep
    // dismissal on the close button, backdrop, and system back so edits can
    // be saved or explicitly discarded; omit the handle for this form.
    enableDrag: false,
    showDragHandle: false,
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

  bool _allowClose = false;
  bool _askingToClose = false;
  final _nameFocus = FocusNode();
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
    _nameFocus.dispose();
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

  bool get _hasUnsavedChanges {
    final original = widget.character;
    if (_nameController.text.trim() != (original?.name ?? '')) return true;
    if (_descriptionEdited &&
        _descriptionController.text.trim() != (original?.description ?? '')) {
      return true;
    }
    final fields = [
      for (final row in _fields)
        if (row.key.text.trim().isNotEmpty || row.value.text.trim().isNotEmpty)
          CharacterField(
            key: row.key.text.trim(),
            value: row.value.text.trim(),
          ),
    ];
    return !_sameFields(fields, original?.fields ?? const []);
  }

  Future<void> _finish([LibraryCharacter? character]) async {
    setState(() => _allowClose = true);
    // Let PopScope publish permission before the route is popped.
    await WidgetsBinding.instance.endOfFrame;
    if (mounted) Navigator.of(context).pop(character);
  }

  Future<void> _requestClose() async {
    if (_busy || _askingToClose) return;
    _askingToClose = true;
    final discard =
        !_hasUnsavedChanges ||
        await showAppConfirmationDialog(
          context,
          title: 'Discard changes?',
          message: 'The changes to this character have not been saved.',
          confirmLabel: 'Discard changes',
          cancelLabel: 'Keep editing',
          destructive: true,
        );
    _askingToClose = false;
    if (discard && mounted && !_busy) await _finish();
  }

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
      _nameFocus.requestFocus();
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
        await _finish();
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
        await _finish(created);
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
        await _finish(updated);
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
    // The @name hint is only true once there is someone else to name.
    final canMentionOthers =
        ref
            .watch(charactersProvider)
            .value
            ?.characters
            .any((character) => character.id != _saved?.id) ??
        false;

    return PopScope<LibraryCharacter>(
      canPop: _allowClose,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) _requestClose();
      },
      child: CharacterEditorLayout(
        creating: creating,
        busy: _busy,
        saving: _saving,
        onClose: _requestClose,
        onSave: _save,
        children: [
          TextField(
            controller: _nameController,
            focusNode: _nameFocus,
            // A new character has nothing to read yet, so the keyboard may
            // come up at once; an existing one is opened to be looked at.
            autofocus: creating,
            textInputAction: TextInputAction.next,
            maxLength: _nameMax,
            textCapitalization: TextCapitalization.words,
            decoration: InputDecoration(
              labelText: 'Name',
              floatingLabelBehavior: FloatingLabelBehavior.always,
              hintText: 'e.g. Mina, Captain Fern, or you',
              counterText: '',
              errorText: _nameError,
            ),
            onChanged: (_) {
              if (_nameError != null) setState(() => _nameError = null);
            },
          ),
          const SizedBox(height: AppSpacing.lg),
          CharacterDescriptionField(
            controller: _descriptionController,
            max: _descriptionMax,
            overflow: _descriptionOverflow,
            onChanged: () => _descriptionEdited = true,
          ),
          if (canMentionOthers) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Use @name to connect them to another character.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
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
            'Details · optional',
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
            runSpacing: 4,
            children: [
              for (final key in _suggestedFieldKeys)
                if (!_hasFieldKey(key))
                  ActionChip(
                    label: Text(key),
                    avatar: const Icon(Icons.add_rounded, size: 16),
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
          if (creating) ...[
            const SizedBox(height: AppSpacing.md),
            Text(
              'Next, add a picture or create their illustration.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
