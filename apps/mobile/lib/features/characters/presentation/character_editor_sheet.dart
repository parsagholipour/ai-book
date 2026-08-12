import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';

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
  return showModalBottomSheet<LibraryCharacter>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _CharacterEditorSheet(character: character),
  );
}

// Mirrors apps/api/src/mobile/characterSchemas.ts.
const _nameMax = 80;
const _descriptionMax = 2000;
const _fieldsMax = 12;
const _fieldKeyMax = 40;
const _fieldValueMax = 300;

const _suggestedFieldKeys = ['Age', 'Job', 'Languages', 'Personality', 'Likes'];

class _CharacterEditorSheet extends ConsumerStatefulWidget {
  const _CharacterEditorSheet({required this.character});

  final LibraryCharacter? character;

  @override
  ConsumerState<_CharacterEditorSheet> createState() =>
      _CharacterEditorSheetState();
}

class _FieldRow {
  _FieldRow({String key = '', String value = ''})
    : key = TextEditingController(text: key),
      value = TextEditingController(text: value);

  final TextEditingController key;
  final TextEditingController value;

  void dispose() {
    key.dispose();
    value.dispose();
  }
}

class _CharacterEditorSheetState extends ConsumerState<_CharacterEditorSheet> {
  late final _nameController = TextEditingController(
    text: widget.character?.name ?? '',
  );
  late final _descriptionController = TextEditingController(
    text: widget.character?.description ?? '',
  );
  late final List<_FieldRow> _fields = [
    for (final field in widget.character?.fields ?? const <CharacterField>[])
      _FieldRow(key: field.key, value: field.value),
  ];

  /// Rows taken out of [_fields] stay alive until the sheet closes: their
  /// text fields may still be animating out when they are removed.
  final List<_FieldRow> _removedFields = [];

  /// The character as the server last confirmed it. Null until a new character
  /// is created; the photo and portrait sections need an id to talk about.
  late LibraryCharacter? _saved = widget.character;

  bool _saving = false;
  bool _suggestionBusy = false;
  String? _nameError;

  /// Set the moment the reader taps "Use this", so the card goes away without
  /// waiting for the PATCH that retires it server-side — which only happens
  /// when they save.
  bool _suggestionTaken = false;

  @override
  void dispose() {
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
    setState(() => _fields.add(_FieldRow(key: key)));
  }

  void _removeField(_FieldRow row) {
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

    setState(() {
      _saving = true;
      _nameError = null;
    });
    try {
      if (saved == null) {
        final created = await ref
            .read(charactersRepositoryProvider)
            .create(name: name, description: description, fields: fields);
        if (!mounted) return;
        ref.invalidate(charactersProvider);
        // Closes and hands the character back: their page is where a face gets
        // added, so staying open with newly-unlocked sections was a waypoint.
        Navigator.of(context).pop(created);
      } else {
        final changedName = name != saved.name ? name : null;
        final changedDescription =
            description != saved.description ? description : null;
        final changedFields = _sameFields(fields, saved.fields) ? null : fields;
        if (changedName == null &&
            changedDescription == null &&
            changedFields == null) {
          Navigator.of(context).pop();
          return;
        }
        await ref.read(charactersRepositoryProvider).update(
          id: saved.id,
          name: changedName,
          description: changedDescription,
          fields: changedFields,
        );
        if (!mounted) return;
        ref.invalidate(charactersProvider);
        Navigator.of(context).pop(saved);
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
              TextField(
                controller: _descriptionController,
                maxLength: _descriptionMax,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'Description',
                  counterText: '',
                  hintText: 'What they look like, how they act, who they are.',
                ),
              ),
              if (suggestion != null) ...[
                const SizedBox(height: 12),
                _suggestionCard(suggestion),
              ],
              const SizedBox(height: 16),
              Text(
                'Details',
                style: theme.textTheme.labelMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 8),
              for (final row in _fields) _fieldRow(row),
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

  Widget _suggestionCard(String suggestion) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.auto_awesome_outlined,
                  size: 16,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(
                  'Suggested from your photo',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(suggestion, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 2),
            Row(
              children: [
                AppButton.text(
                  label: 'Use this',
                  onPressed: _busy ? null : () => _useSuggestion(suggestion),
                ),
                AppButton.text(
                  label: 'Dismiss',
                  onPressed: _busy ? null : _dismissSuggestion,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _fieldRow(_FieldRow row) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 2,
            child: TextField(
              controller: row.key,
              maxLength: _fieldKeyMax,
              decoration: const InputDecoration(
                labelText: 'Detail',
                counterText: '',
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            flex: 3,
            child: TextField(
              controller: row.value,
              maxLength: _fieldValueMax,
              decoration: const InputDecoration(
                labelText: 'Value',
                counterText: '',
              ),
            ),
          ),
          IconButton(
            tooltip: 'Remove detail',
            icon: const Icon(Icons.close),
            onPressed: () => _removeField(row),
          ),
        ],
      ),
    );
  }
}
