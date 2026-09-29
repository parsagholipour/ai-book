import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/media/photo_picker.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';
import '../domain/library_mentions.dart';
import 'character_editor_fields.dart';
import 'character_editor_layout.dart';
import 'character_editor_photo.dart';
import 'character_photo_pick.dart';

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

  /// The frame the reader approved for a new character. Held here and sent once
  /// the character exists, because there is nothing to attach it to before.
  Uint8List? _photo;

  /// The character is made and its photo is on the way up.
  bool _uploadingPhoto = false;

  /// The detail rows a save refused, and which half of each is missing.
  final Map<CharacterDetailRow, ({bool key, bool value})> _rowErrors = {};

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
    if (_photo != null) return true;
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

  /// Trimmed rows ready to send, or null after marking every row that is only
  /// half filled — dropping typed text silently is worse than asking, and the
  /// mark goes on the half that is missing, where the reader will look.
  List<CharacterField>? _collectFields() {
    final collected = <CharacterField>[];
    final refused = <CharacterDetailRow, ({bool key, bool value})>{};
    for (final row in _fields) {
      final key = row.key.text.trim();
      final value = row.value.text.trim();
      if (key.isEmpty && value.isEmpty) continue;
      if (key.isEmpty || value.isEmpty) {
        refused[row] = (key: key.isEmpty, value: value.isEmpty);
        continue;
      }
      collected.add(CharacterField(key: key, value: value));
    }
    if (refused.isNotEmpty) {
      setState(() {
        _rowErrors
          ..clear()
          ..addAll(refused);
      });
      // After the frame that draws the errors, so the row is where it will be.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final target = refused.keys.first.anchor.currentContext;
        if (target != null && mounted) {
          Scrollable.ensureVisible(
            target,
            duration: const Duration(milliseconds: 200),
            alignment: 0.3,
          );
        }
      });
      return null;
    }
    if (_rowErrors.isNotEmpty) setState(_rowErrors.clear);
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
      setState(() => _nameError = 'Add a name so you can find them later.');
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
        final photo = _photo;
        if (photo != null) {
          // The character exists now, so the photo has somewhere to go. It is a
          // courtesy on top of a save that has already worked: a failure here
          // is said, not thrown, because the character is made either way and
          // their page is where the picture can be tried again.
          setState(() => _uploadingPhoto = true);
          try {
            await ref
                .read(charactersRepositoryProvider)
                .uploadPhoto(
                  id: created.id,
                  filename: 'photo.jpg',
                  bytes: photo,
                  mimeType: 'image/jpeg',
                );
          } catch (_) {
            messenger.showAppSnackBar(
              SnackBar(
                content: Text(
                  '${created.name} is saved, but the photo did not upload. '
                  'Add it from their page.',
                ),
              ),
            );
          }
          if (!mounted) return;
          ref.invalidate(charactersProvider);
        }
        // Closes and hands the character back: their page is where the rest of
        // their pictures are, so staying open would be a waypoint.
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
        _uploadingPhoto = false;
        if (error.code == 'CHARACTER_NAME_TAKEN') {
          _nameError = error.message;
        }
      });
      if (error.code != 'CHARACTER_NAME_TAKEN') {
        messenger.showAppSnackBar(SnackBar(content: Text(error.message)));
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _uploadingPhoto = false;
      });
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    }
  }

  Future<void> _choosePhoto() async {
    if (_busy) return;
    final action = await showCharacterPhotoActions(context);
    if (action == null || !mounted) return;
    final cropped = await pickAndCropCharacterPhoto(
      context,
      action: action,
      photoPicker: ref.read(photoPickerProvider),
    );
    if (cropped == null || !mounted) return;
    setState(() => _photo = cropped);
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
        savingLabel: _uploadingPhoto ? 'Uploading photo…' : null,
        onClose: _requestClose,
        onSave: _save,
        children: [
          // Their face first: it is what the rest of the form describes, and it
          // is only asked for once — an existing character's pictures live on
          // their own page.
          if (creating) ...[
            CharacterEditorPhoto(
              nameController: _nameController,
              photo: _photo,
              busy: _busy,
              onChoose: _choosePhoto,
              onRemove: () => setState(() => _photo = null),
            ),
            const SizedBox(height: AppSpacing.lg),
          ],
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
            // The strip appears under the field the reader is typing in, which
            // on a short screen with the keyboard up can be below the fold of
            // the form: it scrolls itself into view rather than offering picks
            // nobody can see.
            _EnsureVisibleOnAppear(child: _mentionSuggestions(_mentionQuery!)),
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
          const SizedBox(height: AppSpacing.lg),
          Semantics(
            header: true,
            child: Text(
              'Details · optional',
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xxs),
          Text(
            'Small facts every book will remember.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          for (final row in _fields)
            CharacterDetailRowField(
              row: row,
              keyMax: _fieldKeyMax,
              valueMax: _fieldValueMax,
              onRemove: () => _removeField(row),
              // Typing in either half is what answers the refusal.
              onChanged: () {
                if (_rowErrors.remove(row) != null) setState(() {});
              },
              keyError: _rowErrors[row]?.key == true
                  ? 'Add a label, like Personality.'
                  : null,
              valueError: _rowErrors[row]?.value == true
                  ? 'Add what your stories should remember.'
                  : null,
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
          if (creating && _photo == null) ...[
            const SizedBox(height: AppSpacing.md),
            Text(
              'No photo yet? You can add a picture, or have one drawn, from '
              'their page after you create them.',
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

/// Scrolls [child] into view once, the frame after it first appears.
class _EnsureVisibleOnAppear extends StatefulWidget {
  const _EnsureVisibleOnAppear({required this.child});

  final Widget child;

  @override
  State<_EnsureVisibleOnAppear> createState() => _EnsureVisibleOnAppearState();
}

class _EnsureVisibleOnAppearState extends State<_EnsureVisibleOnAppear> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Scrollable.ensureVisible(
        context,
        duration: const Duration(milliseconds: 150),
        alignment: 1,
      );
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
