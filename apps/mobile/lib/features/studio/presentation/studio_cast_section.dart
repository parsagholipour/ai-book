import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/domain/character_models.dart';
import '../../characters/presentation/character_avatar.dart';
import '../../characters/presentation/character_profile_screen.dart';
import '../data/studio_repository.dart';
import 'studio_cast_picker_sheet.dart';
import 'studio_session.dart';

/// Shows a message with an optional action, where the host can.
typedef StudioCastNotify =
    void Function(
      String message, {
      String? actionLabel,
      VoidCallback? onAction,
    });

/// The book's cast — the story bible's people — above the chapters: a face for
/// each library character in this book, a way to add more, and a way to take
/// one out.
///
/// The cast is what keeps a character looking like themselves: every picture
/// the Studio draws uses their portraits as its reference. So an empty cast is
/// an invitation, one quiet line, not a card to fill in.
class StudioCastSection extends ConsumerStatefulWidget {
  const StudioCastSection({required this.session, this.notify, super.key});

  final StudioSession session;
  final StudioCastNotify? notify;

  @override
  ConsumerState<StudioCastSection> createState() => _StudioCastSectionState();
}

class _StudioCastSectionState extends ConsumerState<StudioCastSection> {
  bool _saving = false;

  String get _projectId => widget.session.projectId;

  List<String> get _cast =>
      widget.session.manuscript?.castCharacterIds ?? const [];

  void _notify(String message, {String? actionLabel, VoidCallback? onAction}) {
    final notify = widget.notify;
    if (notify != null) {
      notify(message, actionLabel: actionLabel, onAction: onAction);
      return;
    }
    ScaffoldMessenger.maybeOf(context)?.showAppSnackBar(
      SnackBar(
        content: Text(message),
        action: actionLabel == null || onAction == null
            ? null
            : SnackBarAction(label: actionLabel, onPressed: onAction),
      ),
    );
  }

  Future<void> _add() async {
    AppHaptics.tap();
    final manuscript = await showStudioCastPickerSheet(
      context,
      projectId: _projectId,
      castIds: _cast,
    );
    if (manuscript != null) widget.session.updateManuscript(manuscript);
  }

  /// Saves [ids] as the whole cast. Answers whether it went.
  Future<bool> _saveCast(List<String> ids) async {
    setState(() => _saving = true);
    try {
      final manuscript = await ref
          .read(studioRepositoryProvider)
          .updateSettings(
            _projectId,
            ManuscriptSettingsUpdate(castCharacterIds: ids),
          );
      widget.session.updateManuscript(manuscript);
      ref.invalidate(manuscriptProvider(_projectId));
      return true;
    } catch (error) {
      if (mounted) _notify(userFacingError(error));
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _remove(LibraryCharacter character) async {
    final before = _cast;
    final removed = await _saveCast([
      for (final id in before)
        if (id != character.id) id,
    ]);
    if (!removed || !mounted) return;
    _notify(
      '${_nameOf(character)} left the cast',
      actionLabel: 'Undo',
      onAction: () => unawaited(_saveCast(before)),
    );
  }

  Future<void> _memberMenu(LibraryCharacter character) async {
    AppHaptics.longPress();
    final action = await showAppActionSheet<String>(
      context,
      title: _nameOf(character),
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.badge_outlined),
            title: const Text('Open character'),
            subtitle: const Text('Their portrait and who they are'),
            onTap: () => Navigator.of(sheetContext).pop('open'),
          ),
          ListTile(
            key: const ValueKey('cast-remove'),
            leading: const Icon(Icons.person_remove_outlined),
            title: const Text('Remove from cast'),
            subtitle: const Text('They stay in your character library'),
            onTap: () => Navigator.of(sheetContext).pop('remove'),
          ),
        ],
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case 'open':
        await Navigator.of(context).push(characterProfileRoute(character.id));
        if (mounted) ref.invalidate(charactersProvider);
      case 'remove':
        await _remove(character);
    }
  }

  static String _nameOf(LibraryCharacter character) =>
      character.name.trim().isEmpty ? 'This character' : character.name.trim();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final cast = _cast;
    final value = cast.isEmpty ? null : ref.watch(charactersProvider);
    final library = value?.value?.characters;
    final members = library == null
        ? const <LibraryCharacter>[]
        : [
            for (final id in cast)
              for (final character in library)
                if (character.id == id) character,
          ];

    final Widget body;
    if (cast.isEmpty) {
      body = _EmptyCastInvite(key: const ValueKey('cast-empty'), onTap: _add);
    } else if (library == null && (value?.hasError ?? false)) {
      body = Padding(
        key: const ValueKey('cast-error'),
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Could not load your cast.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
            AppButton.text(
              label: 'Try again',
              onPressed: () => ref.invalidate(charactersProvider),
            ),
          ],
        ),
      );
    } else {
      body = Column(
        key: const ValueKey('cast-members'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 76,
            child: library == null
                ? _CastSkeleton(count: cast.length)
                : ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: members.length,
                    separatorBuilder: (_, _) =>
                        const SizedBox(width: AppSpacing.xs),
                    itemBuilder: (context, index) => _CastMember(
                      key: ValueKey('cast-member-${members[index].id}'),
                      character: members[index],
                      onTap: _saving ? null : () => _memberMenu(members[index]),
                    ),
                  ),
          ),
          Text(
            'Pictures of these characters stay consistent across your book.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      );
    }

    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.lg - AppSpacing.xxs,
        0,
        AppSpacing.sm,
        AppSpacing.xs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Cast',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
              if (cast.isNotEmpty)
                AppButton.text(
                  key: const ValueKey('cast-add'),
                  label: 'Add',
                  leading: const Icon(Icons.add_rounded, size: 18),
                  onPressed: _saving ? null : _add,
                ),
            ],
          ),
          AppSwitcher(child: body),
        ],
      ),
    );
  }
}

/// One cast member: a face, and the name under it.
class _CastMember extends StatelessWidget {
  const _CastMember({required this.character, required this.onTap, super.key});

  final LibraryCharacter character;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = character.name.trim();
    return Semantics(
      container: true,
      button: true,
      label: '${name.isEmpty ? 'Unnamed character' : name}, in the cast',
      hint: 'Options',
      onTap: onTap,
      onLongPress: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          onTap: onTap,
          onLongPress: onTap,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: SizedBox(
            width: 64,
            child: Column(
              children: [
                const SizedBox(height: 4),
                CharacterAvatar(character: character, radius: 22),
                const SizedBox(height: 4),
                Text(
                  name.isEmpty ? '—' : name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The empty cast: one line that reads as an invitation, not a form.
class _EmptyCastInvite extends StatelessWidget {
  const _EmptyCastInvite({required this.onTap, super.key});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      container: true,
      button: true,
      label:
          'Add the characters in your book. Their pictures stay consistent '
          'across your book.',
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
            child: Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.outlineVariant),
                  ),
                  child: SizedBox.square(
                    dimension: 40,
                    child: Icon(
                      Icons.person_add_alt_1_outlined,
                      size: 20,
                      color: colors.primary,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Add the characters in your book',
                        style: theme.textTheme.titleSmall?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Their pictures stay consistent across your book.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CastSkeleton extends StatelessWidget {
  const _CastSkeleton({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: 'Loading your cast',
      child: Row(
        children: [
          for (var i = 0; i < count.clamp(1, 5); i++)
            const Padding(
              padding: EdgeInsetsDirectional.only(end: AppSpacing.xs),
              child: SizedBox(
                width: 64,
                child: Column(
                  children: [
                    SizedBox(height: 4),
                    AppSkeleton.circle(size: 44),
                    SizedBox(height: 6),
                    AppSkeleton.line(width: 40),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
