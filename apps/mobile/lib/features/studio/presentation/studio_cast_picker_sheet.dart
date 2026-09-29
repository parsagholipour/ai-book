import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/domain/character_models.dart';
import '../../characters/presentation/character_avatar.dart';
import '../../characters/presentation/character_editor_sheet.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';

/// The most characters a book's cast holds (the settings route's limit).
const studioCastLimit = 24;

/// Past this many characters the picker offers a search.
const _searchAfter = 8;

/// Picks the book's cast from the author's character library and saves the
/// whole list. Resolves with the updated working copy, or null when nothing
/// was saved.
Future<Manuscript?> showStudioCastPickerSheet(
  BuildContext context, {
  required String projectId,
  required List<String> castIds,
}) {
  return showAppBottomSheet<Manuscript>(
    context,
    builder: (_) =>
        StudioCastPickerSheet(projectId: projectId, castIds: castIds),
  );
}

@visibleForTesting
class StudioCastPickerSheet extends ConsumerStatefulWidget {
  const StudioCastPickerSheet({
    required this.projectId,
    required this.castIds,
    super.key,
  });

  final String projectId;
  final List<String> castIds;

  @override
  ConsumerState<StudioCastPickerSheet> createState() =>
      _StudioCastPickerSheetState();
}

class _StudioCastPickerSheetState extends ConsumerState<StudioCastPickerSheet> {
  /// In cast order: the ones already in it first, then each one ticked since,
  /// in the order they were ticked.
  late final LinkedHashSet<String> _selected = LinkedHashSet.of(widget.castIds);
  final _search = TextEditingController();
  String _query = '';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// The cast to save: every ticked character the library still has.
  List<String> _castFrom(List<LibraryCharacter> library) {
    final known = {for (final character in library) character.id};
    return [
      for (final id in _selected)
        if (known.contains(id)) id,
    ];
  }

  bool _changed(List<LibraryCharacter> library) {
    final next = _castFrom(library);
    final before = widget.castIds;
    if (next.length != before.length) return true;
    for (var i = 0; i < next.length; i++) {
      if (next[i] != before[i]) return true;
    }
    return false;
  }

  void _toggle(String id, bool on) {
    AppHaptics.selection();
    setState(() {
      _error = null;
      if (on) {
        _selected.add(id);
      } else {
        _selected.remove(id);
      }
    });
  }

  Future<void> _create() async {
    final created = await showCharacterEditorSheet(context);
    if (created == null || !mounted) return;
    ref.invalidate(charactersProvider);
    // A character made from here is made for this book.
    if (_selected.length < studioCastLimit) _toggle(created.id, true);
  }

  Future<void> _save(List<LibraryCharacter> library) async {
    if (_saving) return;
    if (!_changed(library)) {
      Navigator.of(context).pop();
      return;
    }
    final ids = _castFrom(library);
    final container = ProviderScope.containerOf(context, listen: false);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final manuscript = await ref
          .read(studioRepositoryProvider)
          .updateSettings(
            widget.projectId,
            ManuscriptSettingsUpdate(castCharacterIds: ids),
          );
      container.invalidate(manuscriptProvider(widget.projectId));
      if (!mounted) return;
      AppHaptics.success();
      Navigator.of(context).pop(manuscript);
    } catch (error) {
      if (!mounted) return;
      AppHaptics.error();
      setState(() {
        _saving = false;
        _error = userFacingError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(charactersProvider);
    final library = value.value?.characters;
    final changed = library != null && _changed(library);
    return AppSheetScaffold(
      title: 'Your cast',
      subtitle: 'Pick who appears in this book.',
      icon: Icons.groups_outlined,
      onClose: _saving ? null : () => Navigator.of(context).pop(),
      footer: library == null
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null) ...[
                  AppInlineNotice(
                    tone: AppTone.error,
                    title: 'Could not save your cast',
                    message: _error!,
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],
                AppButton.primary(
                  key: const ValueKey('cast-save'),
                  label: changed ? 'Save cast' : 'Done',
                  loading: _saving,
                  loadingLabel: 'Saving your cast',
                  expanded: true,
                  onPressed: () => _save(library),
                ),
              ],
            ),
      children: [
        AppSwitcher(
          child: library != null
              ? _list(context, library)
              : value.hasError
              ? AppInlineNotice(
                  key: const ValueKey('cast-library-error'),
                  tone: AppTone.error,
                  title: 'Could not load your characters',
                  message: userFacingError(value.error!),
                  actionLabel: 'Try again',
                  onAction: () => ref.invalidate(charactersProvider),
                )
              : const AppSkeletonList(
                  key: ValueKey('cast-library-loading'),
                  itemCount: 4,
                  leading: AppSkeletonLeading.circle,
                  label: 'Loading your characters',
                ),
        ),
      ],
    );
  }

  Widget _list(BuildContext context, List<LibraryCharacter> library) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final query = _query.trim().toLowerCase();
    final shown = query.isEmpty
        ? library
        : [
            for (final character in library)
              if (character.name.toLowerCase().contains(query) ||
                  character.description.toLowerCase().contains(query))
                character,
          ];
    final full = _selected.length >= studioCastLimit;
    return Column(
      key: const ValueKey('cast-library'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (library.length > _searchAfter) ...[
          TextField(
            key: const ValueKey('cast-search'),
            controller: _search,
            onChanged: (text) => setState(() => _query = text),
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: 'Search your characters',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: 'Clear search',
                      icon: const Icon(Icons.close),
                      onPressed: () => setState(() {
                        _search.clear();
                        _query = '';
                      }),
                    ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
        ],
        ListTile(
          key: const ValueKey('cast-new-character'),
          contentPadding: EdgeInsets.zero,
          leading: CircleAvatar(
            radius: 20,
            backgroundColor: colors.primaryContainer,
            child: Icon(Icons.person_add_alt_1, color: colors.primary),
          ),
          title: Text(
            'New character',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w700,
              color: colors.primary,
            ),
          ),
          subtitle: const Text('Describe someone, and they join this book.'),
          onTap: _saving ? null : _create,
        ),
        Divider(height: AppSpacing.md, color: colors.outlineVariant),
        if (library.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(
              'Your character library is empty. Characters you make here '
              'are kept there too, ready for your other books.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
                height: 1.4,
              ),
            ),
          )
        else if (shown.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: Text(
              'No character matches “${_query.trim()}”.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        for (final character in shown)
          _CastCandidate(
            key: ValueKey('cast-candidate-${character.id}'),
            character: character,
            selected: _selected.contains(character.id),
            onChanged: _saving || (full && !_selected.contains(character.id))
                ? null
                : (on) => _toggle(character.id, on),
          ),
        if (full)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xs),
            child: Text(
              'A cast holds up to $studioCastLimit characters.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }
}

class _CastCandidate extends StatelessWidget {
  const _CastCandidate({
    required this.character,
    required this.selected,
    required this.onChanged,
    super.key,
  });

  final LibraryCharacter character;
  final bool selected;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final description = character.description.trim();
    return CheckboxListTile(
      value: selected,
      onChanged: onChanged == null ? null : (on) => onChanged!(on ?? false),
      contentPadding: EdgeInsets.zero,
      controlAffinity: ListTileControlAffinity.trailing,
      secondary: CharacterAvatar(character: character, radius: 20),
      title: Text(
        character.name.trim().isEmpty ? 'Unnamed character' : character.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.titleSmall?.copyWith(
          fontWeight: FontWeight.w700,
        ),
      ),
      subtitle: description.isEmpty
          ? null
          : Text(description, maxLines: 1, overflow: TextOverflow.ellipsis),
    );
  }
}
