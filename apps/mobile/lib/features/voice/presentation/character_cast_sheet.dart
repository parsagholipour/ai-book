import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/motion.dart';
import '../../../shared/ui/polling_state_mixin.dart';
import '../data/voice_repository.dart';
import '../domain/voice_models.dart';
import 'voice_call_avatar.dart';
import 'voice_call_launcher.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';

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
  return showAppBottomSheet<void>(
    context,
    builder: (context) =>
        _CharacterCastSheet(projectId: projectId, pageIndex: pageIndex),
  );
}

class _CharacterCastSheet extends ConsumerStatefulWidget {
  const _CharacterCastSheet({required this.projectId, this.pageIndex});

  final String projectId;
  final int? pageIndex;

  @override
  ConsumerState<_CharacterCastSheet> createState() =>
      _CharacterCastSheetState();
}

class _CharacterCastSheetState extends ConsumerState<_CharacterCastSheet>
    with PollingStateMixin<_CharacterCastSheet> {
  /// A character being prepared becomes callable on its own within seconds.
  /// Polling keeps the list honest without asking the user to pull to refresh.
  void _pollWhilePreparing(VoiceCast cast) {
    final preparing = cast.characters.any(
      (character) => character.status == VoiceCharacterStatus.preparing,
    );
    if (!preparing) {
      stopPolling();
      return;
    }
    startPolling(const Duration(seconds: 4), () {
      ref.invalidate(voiceCastProvider(widget.projectId));
    });
  }

  @override
  Widget build(BuildContext context) {
    final castValue = ref.watch(voiceCastProvider(widget.projectId));
    castValue.whenData(_pollWhilePreparing);
    // Calls are a plan perk: a free reader still sees the cast, each row
    // wearing a lock, and a tap opens the plans instead of the call.
    final planLocked = voiceCallsLockedByPlan(
      ref.watch(billingProvider).asData?.value,
    );

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: castValue.when(
            loading: () => const _CastSkeleton(),
            error: (error, stackTrace) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: AppErrorState(
                title: 'Characters unavailable',
                message: userFacingError(error),
                actionLabel: 'Retry',
                onRetry: () =>
                    ref.invalidate(voiceCastProvider(widget.projectId)),
              ),
            ),
            data: (cast) => cast.isEmpty
                ? const _NoCharacters()
                : _CastList(
                    cast: cast,
                    projectId: widget.projectId,
                    pageIndex: widget.pageIndex,
                    planLocked: planLocked,
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
    this.planLocked = false,
  });

  final VoiceCast cast;
  final String projectId;
  final int? pageIndex;

  /// Calls are a plan perk this reader does not have yet.
  final bool planLocked;

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
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          _costLine(cast),
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 10),
        // The two numbers a caller wants before dialling, both from the cast
        // read: what they have, and how long one call can run.
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            AppMetricChip(
              icon: Icons.toll_outlined,
              label: 'Balance',
              value: '${formatCredits(cast.availableCredits)} credits',
            ),
            if (cast.maxCallSeconds > 0)
              AppMetricChip(
                icon: Icons.timer_outlined,
                label: 'Each call',
                value: 'up to ${cast.maxCallSeconds ~/ 60} min',
              ),
          ],
        ),
        const SizedBox(height: 12),
        Flexible(
          child: ListView.separated(
            shrinkWrap: true,
            itemCount: cast.characters.length,
            separatorBuilder: (context, index) => const SizedBox(height: 4),
            itemBuilder: (context, index) => _CastRow(
              character: cast.characters[index],
              cast: cast,
              projectId: projectId,
              pageIndex: pageIndex,
              planLocked: planLocked,
            ),
          ),
        ),
      ],
    );
  }

  String _costLine(VoiceCast cast) {
    if (planLocked) {
      return '$voiceCallsPlanMessage Tap a character to see plans.';
    }
    if (!cast.canAfford) {
      return creditsNeededToStartCallMessage(cast.creditsToStart);
    }
    final minutes = cast.affordableMinutes;
    return '${cast.creditsPerMinute} credits a minute · about $minutes '
        '${minutes == 1 ? 'minute' : 'minutes'} left on your balance';
  }
}

class _CastRow extends ConsumerWidget {
  const _CastRow({
    required this.character,
    required this.cast,
    required this.projectId,
    this.pageIndex,
    this.planLocked = false,
  });

  final VoiceCharacter character;
  final VoiceCast cast;
  final String projectId;
  final int? pageIndex;

  /// Draws the call button as a lock; the tap opens the plans.
  final bool planLocked;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final affordable = cast.canAfford;
    // Still tappable when the balance cannot cover the opening hold: a
    // disabled row swallows the tap, and the cost line above is easy to miss.
    // The toast is what names the number.
    final enabled = character.callable;

    final ready = enabled && (affordable || planLocked);
    final VoidCallback? placeCall = enabled
        ? () => _placeCall(context, ref)
        : null;
    return Semantics(
      container: true,
      button: true,
      enabled: enabled,
      label:
          'Call ${character.name}${_subtitle().isEmpty ? '' : ', ${_subtitle()}'}',
      onTap: placeCall,
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.control),
          onTap: placeCall,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  VoiceCallAvatar(
                    character: character,
                    speaking: false,
                    connected: false,
                    diameter: 44,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          character.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                            color: enabled
                                ? colors.onSurface
                                : colors.onSurfaceVariant,
                          ),
                        ),
                        Text(
                          _subtitle(),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                        // Under the name rather than beside it, where it took
                        // the room a long name needed.
                        if (character.fromLibrary) ...[
                          const SizedBox(height: 4),
                          const _FromLibraryBadge(),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: ready
                          ? colors.primaryContainer
                          : colors.surfaceContainerHigh,
                    ),
                    child: Icon(
                      planLocked ? Icons.lock_outline : Icons.call,
                      key: planLocked
                          ? const ValueKey('voice-cast-call-locked')
                          : null,
                      size: 22,
                      color: ready
                          ? colors.onPrimaryContainer
                          : colors.onSurfaceVariant.withValues(alpha: 0.5),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _placeCall(BuildContext context, WidgetRef ref) {
    // The sheet gets out of the way of both the toast and the call screen.
    return launchVoiceCall(
      context: context,
      ref: ref,
      projectId: projectId,
      character: character,
      cast: cast,
      pageIndex: pageIndex,
      leave: Navigator.of(context).pop,
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

/// Says that this cast member is one of the reader's own saved characters,
/// rather than someone the book invented who happens to share the name.
///
/// A quiet readout, not a control: surface tones and no primary fill, because
/// tapping the row still means "call", exactly as it does for every other name
/// in this list.
class _FromLibraryBadge extends StatelessWidget {
  const _FromLibraryBadge();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.people_outline, size: 13, color: colors.onSurfaceVariant),
          const SizedBox(width: 4),
          Text(
            'From your characters',
            style: theme.textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
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
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
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

/// Rows in the shape of the real ones while the cast is on its way.
class _CastSkeleton extends StatelessWidget {
  const _CastSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    Widget block(double width, double height, {double radius = 8}) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading characters',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Column(
              children: [
                for (var i = 0; i < 3; i += 1)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        block(44, 44, radius: 22),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              block(120, 16),
                              const SizedBox(height: 8),
                              block(200, 12),
                            ],
                          ),
                        ),
                        block(44, 44, radius: 22),
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
