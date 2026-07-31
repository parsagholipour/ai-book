import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../data/voice_repository.dart';
import '../domain/voice_models.dart';
import 'voice_call_avatar.dart';
import 'voice_call_screen.dart';

/// "Who do you want to talk to?"
///
/// A bottom sheet rather than a screen: picking a character is one tap on the
/// way to the call, not a destination. Characters still being prepared stay in
/// the list and stay tappable — the call screen shows the wait as ringing,
/// which is a far better answer than a disabled row with no explanation.
Future<void> showCharacterCastSheet({
  required BuildContext context,
  required String projectId,
  int? pageIndex,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _CharacterCastSheet(projectId: projectId, pageIndex: pageIndex),
  );
}

class _CharacterCastSheet extends ConsumerStatefulWidget {
  const _CharacterCastSheet({required this.projectId, this.pageIndex});

  final String projectId;
  final int? pageIndex;

  @override
  ConsumerState<_CharacterCastSheet> createState() => _CharacterCastSheetState();
}

class _CharacterCastSheetState extends ConsumerState<_CharacterCastSheet> {
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  /// A character being prepared becomes callable on its own within seconds.
  /// Polling keeps the list honest without asking the user to pull to refresh.
  void _pollWhilePreparing(VoiceCast cast) {
    final preparing = cast.characters.any(
      (character) => character.status == VoiceCharacterStatus.preparing,
    );
    if (!preparing) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    _poll ??= Timer.periodic(const Duration(seconds: 4), (_) {
      ref.invalidate(voiceCastProvider(widget.projectId));
    });
  }

  @override
  Widget build(BuildContext context) {
    final castValue = ref.watch(voiceCastProvider(widget.projectId));
    castValue.whenData(_pollWhilePreparing);

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: castValue.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 48),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (error, stackTrace) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: AppErrorState(
                title: 'Characters unavailable',
                message: userFacingError(error),
                actionLabel: 'Retry',
                onRetry: () => ref.invalidate(voiceCastProvider(widget.projectId)),
              ),
            ),
            data: (cast) => cast.isEmpty
                ? const _NoCharacters()
                : _CastList(
                    cast: cast,
                    projectId: widget.projectId,
                    pageIndex: widget.pageIndex,
                  ),
          ),
        ),
      ),
    );
  }
}

class _CastList extends StatelessWidget {
  const _CastList({
    required this.cast,
    required this.projectId,
    this.pageIndex,
  });

  final VoiceCast cast;
  final String projectId;
  final int? pageIndex;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Call a character',
          style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 4),
        Text(
          _costLine(cast),
          style: theme.textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        Flexible(
          child: ListView.separated(
            shrinkWrap: true,
            itemCount: cast.characters.length,
            separatorBuilder: (context, index) => const SizedBox(height: 4),
            itemBuilder: (context, index) => _CastRow(
              character: cast.characters[index],
              affordable: cast.canAfford,
              projectId: projectId,
              pageIndex: pageIndex,
            ),
          ),
        ),
      ],
    );
  }

  String _costLine(VoiceCast cast) {
    if (!cast.canAfford) {
      return 'You need ${cast.creditsToStart} credits to start a call.';
    }
    final minutes = cast.affordableMinutes;
    return '${cast.creditsPerMinute} credits a minute · about $minutes '
        '${minutes == 1 ? 'minute' : 'minutes'} left on your balance';
  }
}

class _CastRow extends ConsumerWidget {
  const _CastRow({
    required this.character,
    required this.affordable,
    required this.projectId,
    this.pageIndex,
  });

  final VoiceCharacter character;
  final bool affordable;
  final String projectId;
  final int? pageIndex;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final enabled = character.callable && affordable;

    return ListTile(
      contentPadding: EdgeInsets.zero,
      enabled: enabled,
      leading: VoiceCallAvatar(
        character: character,
        speaking: false,
        connected: false,
        diameter: 44,
      ),
      title: Text(
        character.name,
        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        _subtitle(),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
      ),
      trailing: Icon(
        Icons.call,
        color: enabled ? colors.primary : colors.onSurfaceVariant.withValues(alpha: 0.4),
      ),
      onTap: enabled
          ? () {
              AppHaptics.commit();
              Navigator.of(context).pop();
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (context) => VoiceCallScreen(
                    projectId: projectId,
                    character: character,
                    pageIndex: pageIndex,
                  ),
                ),
              );
            }
          : null,
    );
  }

  String _subtitle() {
    if (character.status == VoiceCharacterStatus.preparing) {
      return 'Getting ready to talk…';
    }
    if (character.status == VoiceCharacterStatus.unavailable) {
      return 'Not available for calls';
    }
    final role = character.role.trim();
    return role.isEmpty ? character.description : role;
  }
}

class _NoCharacters extends StatelessWidget {
  const _NoCharacters();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 8, 0, 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.record_voice_over_outlined,
            size: 40,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 12),
          Text(
            'No one to call yet',
            style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            'Characters appear once the book is finished. Books without '
            'characters — guides and workbooks — will not have any.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
