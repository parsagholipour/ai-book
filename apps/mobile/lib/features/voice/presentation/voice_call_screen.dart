import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../../shared/ui/motion.dart';
import '../domain/voice_models.dart';
import 'voice_call_controller.dart';
import 'voice_call_menu.dart';
import 'voice_call_stage.dart';

part 'voice_call_transcript.dart';

/// The call itself.
///
/// Modelled on a phone call rather than on a chat: one face, one status line,
/// and three controls sized for a thumb. The transcript is present but
/// secondary — it is there for a noisy bus or a hard-of-hearing reader, not as
/// the main event.
class VoiceCallScreen extends ConsumerStatefulWidget {
  const VoiceCallScreen({
    required this.projectId,
    required this.character,
    this.pageIndex,
    super.key,
  });

  /// The book the character is in, or null for a call placed from the
  /// reader's own character library.
  final String? projectId;
  final VoiceCharacter character;

  /// The book page the caller was reading, when the call came from the reader.
  final int? pageIndex;

  @override
  ConsumerState<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends ConsumerState<VoiceCallScreen> {
  @override
  void initState() {
    super.initState();
    // A call is a screen you look away from. Without this the display sleeps
    // mid-conversation and takes the call's controls with it.
    WakelockPlus.enable().catchError((_) => false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref
          .read(voiceCallControllerProvider.notifier)
          .dial(
            projectId: widget.projectId,
            character: widget.character,
            pageIndex: widget.pageIndex,
          );
    });
  }

  @override
  void dispose() {
    WakelockPlus.disable().catchError((_) => false);
    super.dispose();
  }

  /// Places the same call again. The controller accepts a new dial once the
  /// last call has ended or failed, and answers a balance that cannot cover it
  /// with its own plain message.
  void _callAgain() {
    AppHaptics.commit();
    ref
        .read(voiceCallControllerProvider.notifier)
        .dial(
          projectId: widget.projectId,
          character:
              ref.read(voiceCallControllerProvider).character ??
              widget.character,
          pageIndex: widget.pageIndex,
        );
  }

  @override
  Widget build(BuildContext context) {
    // The phone buzzes when the line opens, drops, or fails: the three moments
    // a caller looking away would otherwise miss.
    ref.listen(voiceCallControllerProvider.select((state) => state.phase), (
      previous,
      next,
    ) {
      if (previous == next) return;
      switch (next) {
        case VoiceCallPhase.connected:
          if (previous != VoiceCallPhase.reconnecting) AppHaptics.success();
        case VoiceCallPhase.reconnecting:
          AppHaptics.warning();
        case VoiceCallPhase.failed:
          AppHaptics.error();
        case _:
          break;
      }
    });
    final state = ref.watch(voiceCallControllerProvider);
    final controller = ref.read(voiceCallControllerProvider.notifier);
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    return PopScope(
      // Leaving the screen has to settle the call, or the credit hold stays out
      // until the server's sweep notices. Back is allowed, but it hangs up.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await controller.hangUp();
        if (context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        backgroundColor: colors.surfaceContainerLowest,
        body: SafeArea(
          child: Column(
            children: [
              // Fixed height whether or not the menu is there, so a call that
              // could not open a recording lays the avatar out identically to
              // one that could.
              const SizedBox(
                height: 48,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: Align(
                    alignment: AlignmentDirectional.centerEnd,
                    child: VoiceCallMenu(),
                  ),
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final character = state.character ?? widget.character;
                      // The face gives up room to the captions once there are
                      // any, and to the reader's text size before that.
                      final scale =
                          MediaQuery.textScalerOf(context).scale(16) / 16;
                      final share =
                          state.captions.isEmpty && state.liveCaptions.isEmpty
                          ? 0.34
                          : 0.24;
                      final diameter =
                          (constraints.maxHeight *
                                  share /
                                  math.max(1, scale * 0.8))
                              .clamp(88.0, 168.0);
                      final top = VoiceCallMoodBuilder(
                        state: state,
                        builder: (context, mood) => Column(
                          children: [
                            VoiceCallStage(
                              character: character,
                              mood: mood,
                              muted: state.muted && state.isLive,
                              diameter: diameter,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              character.name,
                              style: theme.textTheme.headlineSmall?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 6),
                            _CallStatusLine(state: state),
                            if (state.isLive) ...[
                              const SizedBox(height: 10),
                              // A fixed slot that only fades: a pill that
                              // grew into place would resize the captions
                              // under it and pull the newest line off screen.
                              SizedBox(
                                height: 34,
                                child: AnimatedSwitcher(
                                  duration: AppMotion.reducedMotion(context)
                                      ? Duration.zero
                                      : AppMotion.fast,
                                  child: VoiceCallMoodPill(
                                    key: ValueKey(mood),
                                    mood: mood,
                                    characterName: character.name,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                      );
                      // What the top of the screen needs before the captions get
                      // any room. When a large text size or a short phone leaves
                      // less than that, the whole column scrolls instead of
                      // overflowing, and the captions keep a fixed height.
                      final needed = 88 * 1.52 + 120 * math.max(1, scale) + 100;
                      if (constraints.maxHeight < needed) {
                        return SingleChildScrollView(
                          child: Column(
                            children: [
                              top,
                              const SizedBox(height: 14),
                              SizedBox(
                                height: 200,
                                child: _CallTranscript(state: state),
                              ),
                            ],
                          ),
                        );
                      }
                      return Column(
                        children: [
                          top,
                          const SizedBox(height: 14),
                          Expanded(child: _CallTranscript(state: state)),
                        ],
                      );
                    },
                  ),
                ),
              ),
              _CallFooter(
                state: state,
                controller: controller,
                onCallAgain: _callAgain,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CallStatusLine extends StatelessWidget {
  const _CallStatusLine({required this.state});

  final VoiceCallState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final character = state.character?.name ?? 'them';
    final (label, tone) = switch (state.phase) {
      VoiceCallPhase.idle ||
      VoiceCallPhase.ringing => ('Connecting…', colors.onSurfaceVariant),
      // The first call to a character builds their persona. Naming what is
      // happening beats a spinner that looks like a stuck connection.
      VoiceCallPhase.preparing => (
        'Waking $character up…',
        colors.onSurfaceVariant,
      ),
      VoiceCallPhase.connected => (
        formatCallDuration(state.elapsedSeconds),
        colors.onSurfaceVariant,
      ),
      VoiceCallPhase.reconnecting => ('Reconnecting…', colors.tertiary),
      VoiceCallPhase.ended => (
        'Call ended · ${formatCallDuration(state.elapsedSeconds)}',
        colors.onSurfaceVariant,
      ),
      VoiceCallPhase.failed => (
        state.error ?? 'The call could not connect.',
        colors.error,
      ),
    };

    return Column(
      children: [
        // Keyed on the phase, not on the text. The label carries a clock that
        // reads a new value every second, and keying on it made `AppSwitcher`
        // animate a fresh child in from zero height once a second — which
        // shoved everything below it, transcript included, up and down.
        // Genuine phase changes still cross-fade; a ticking second does not.
        AppSwitcher(
          child: Text(
            label,
            key: ValueKey(state.phase),
            style: theme.textTheme.bodyMedium?.copyWith(
              color: tone,
              // Even digits, so the timer does not jitter sideways as the
              // glyphs change width.
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
            textAlign: TextAlign.center,
          ),
        ),
        if (state.showTimeWarning) ...[
          const SizedBox(height: 8),
          _TimeWarning(
            text: switch (state.endingReason) {
              VoiceCallEndingReason.credits =>
                'Out of credits — ending in ${formatRemaining(state.secondsRemaining)}',
              VoiceCallEndingReason.limit =>
                'Call limit reached — ending in ${formatRemaining(state.secondsRemaining)}',
              null => 'Ending in ${formatRemaining(state.secondsRemaining)}',
            },
          ),
        ],
        if (state.phase == VoiceCallPhase.ended &&
            state.chargedCredits > 0) ...[
          const SizedBox(height: 6),
          Text(
            '${state.chargedCredits} credits',
            style: theme.textTheme.labelMedium?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
  }
}

/// The countdown to a call that is about to end, in the warning tone: it is the
/// one thing on this screen that asks the caller to do something.
class _TimeWarning extends StatelessWidget {
  const _TimeWarning({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tone = appToneColors(context, AppTone.warning);
    return Semantics(
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: tone.background,
          borderRadius: BorderRadius.circular(AppRadii.pill),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.timer_outlined, size: 16, color: tone.foreground),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  text,
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: tone.foreground,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CallFooter extends StatelessWidget {
  const _CallFooter({
    required this.state,
    required this.controller,
    required this.onCallAgain,
  });

  final VoiceCallState state;
  final VoiceCallController controller;
  final VoidCallback onCallAgain;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final finished =
        state.phase == VoiceCallPhase.ended ||
        state.phase == VoiceCallPhase.failed;

    // Scrolls rather than overflows: the ended state stacks an explanation and
    // up to three buttons, which a short phone at a large text size cannot hold.
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.55,
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Required disclosure, and honest: this is a synthesised voice, not
            // a recording of a person. The second half is the same kind of
            // honesty about the other direction — the caller's own voice is
            // being written to a file, and they should not have to open a menu
            // to find that out.
            Text(
              state.recordingAvailable
                  ? 'AI voice · recorded on this device'
                  : 'AI voice',
              style: theme.textTheme.labelSmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            if (finished)
              _FinishedCallActions(state: state, onCallAgain: onCallAgain)
            else
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _CallControl(
                    id: 'mute',
                    icon: state.muted ? Icons.mic_off : Icons.mic,
                    label: state.muted ? 'Unmute' : 'Mute',
                    active: state.muted,
                    enabled: state.isLive,
                    onPressed: () {
                      AppHaptics.selection();
                      controller.toggleMute();
                    },
                  ),
                  _CallControl(
                    id: 'end',
                    icon: Icons.call_end,
                    label: 'End',
                    destructive: true,
                    enabled: true,
                    onPressed: () async {
                      AppHaptics.commit();
                      // A call with a recording lands on the ended screen
                      // instead of popping. Hanging up is how most calls end,
                      // and popping straight to the book would take the
                      // recording with it before the caller was ever offered it.
                      final keepScreen = state.recordingAvailable;
                      await controller.hangUp();
                      if (!keepScreen && context.mounted) {
                        Navigator.of(context).pop();
                      }
                    },
                  ),
                  _CallControl(
                    id: 'speaker',
                    icon: state.speakerphone ? Icons.volume_up : Icons.hearing,
                    label: state.speakerphone ? 'Speaker' : 'Earpiece',
                    active: state.speakerphone,
                    enabled: state.isLive,
                    onPressed: () {
                      AppHaptics.selection();
                      controller.toggleSpeakerphone();
                    },
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// What the caller is offered once the line has gone.
///
/// A call that ended on its own has to say why. "Call ended" alone reads as a
/// fault when it was really the meter, and a caller who ran out of credits
/// should not have to go hunting through the account screen to fix it. Every
/// ending also offers to ring again — a dropped line and a mistapped End are
/// both things people want to undo — except one that ended for want of credits,
/// where ringing again would only fail.
class _FinishedCallActions extends StatelessWidget {
  const _FinishedCallActions({required this.state, required this.onCallAgain});

  final VoiceCallState state;
  final VoidCallback onCallAgain;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = state.phase == VoiceCallPhase.failed;
    final needsCredits =
        state.endedBecause == VoiceCallEndingReason.credits ||
        (failed && state.outOfCredits);
    // A library call was placed from the character's own page, not a book.
    final backLabel = state.character?.projectId == null
        ? 'Back to ${state.character?.name ?? 'the character'}'
        : 'Back to the book';
    final explanation = switch (state.endedBecause) {
      VoiceCallEndingReason.credits =>
        'The call ended when your credits ran out.',
      VoiceCallEndingReason.limit =>
        'Calls stop at ${state.maxCallSeconds ~/ 60} minutes. Call again to keep talking.',
      null => null,
    };
    // The microphone refusal is the one failure the caller can fix themselves.
    final micDenied =
        failed && (state.error ?? '').contains('microphone access');

    Widget note(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );

    void back() {
      AppHaptics.tap();
      Navigator.of(context).pop();
    }

    final callAgain = Icon(failed ? Icons.refresh : Icons.call);
    // Which button leads: the fix when there is one, otherwise the way on.
    final callAgainFirst =
        failed || state.endedBecause == VoiceCallEndingReason.limit;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (explanation != null) note(explanation),
        if (micDenied)
          note(
            'You can allow the microphone for Tomeza in your phone\'s Settings, then call again.',
          ),
        // The menu is a small icon in the far corner, and this is the last
        // moment the recording exists. Say where it is rather than leaving the
        // caller to find it.
        if (state.recordingAvailable)
          note('The recording is under the menu, top right.'),
        if (needsCredits) ...[
          AppButton.primary(
            label: 'Add credits',
            leading: const Icon(Icons.add_card_outlined),
            onPressed: () {
              AppHaptics.tap();
              // Calls are charged by the minute, so there is no total to be
              // short of — the card says what ran out and offers both ways to
              // top it back up.
              showBillingPaywall(
                context,
                projectId: state.character?.projectId,
                title: null,
                creditsNeeded: const PaywallCreditsNeeded(
                  reason:
                      'Talking to your characters. Calls spend credits by the '
                      'minute.',
                ),
              );
            },
          ),
          const SizedBox(height: 8),
          AppButton.text(
            label: backLabel,
            leading: const Icon(Icons.arrow_back),
            onPressed: back,
          ),
        ] else if (callAgainFirst) ...[
          AppButton.primary(
            label: 'Call again',
            leading: callAgain,
            onPressed: onCallAgain,
          ),
          const SizedBox(height: 8),
          AppButton.text(
            label: backLabel,
            leading: const Icon(Icons.arrow_back),
            onPressed: back,
          ),
        ] else ...[
          AppButton.primary(
            label: backLabel,
            leading: const Icon(Icons.arrow_back),
            onPressed: back,
          ),
          const SizedBox(height: 8),
          AppButton.text(
            label: 'Call again',
            leading: callAgain,
            onPressed: onCallAgain,
          ),
        ],
      ],
    );
  }
}

class _CallControl extends StatelessWidget {
  const _CallControl({
    required this.id,
    required this.icon,
    required this.label,
    required this.enabled,
    required this.onPressed,
    this.active = false,
    this.destructive = false,
  });

  /// Stable across state changes, unlike [label], which flips between "Mute"
  /// and "Unmute" as the call runs.
  final String id;

  final IconData icon;
  final String label;
  final bool enabled;
  final bool active;
  final bool destructive;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final background = destructive
        ? colors.error
        : active
        ? colors.primaryContainer
        : colors.surfaceContainerHighest;
    final foreground = destructive
        ? colors.onError
        : active
        ? colors.onPrimaryContainer
        : colors.onSurfaceVariant;

    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Opacity(
            opacity: enabled ? 1 : 0.4,
            child: Material(
              color: background,
              shape: const CircleBorder(),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                key: ValueKey('call-control-$id'),
                onTap: enabled ? onPressed : null,
                child: SizedBox.square(
                  dimension: destructive ? 72 : 64,
                  child: Icon(
                    icon,
                    color: foreground,
                    size: destructive ? 30 : 26,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// Time left, worded for its size.
///
/// A credit warning now appears with minutes to go, where a bare second count
/// ("170s") reads as noise; under a minute, "45s" is plainer than "0:45".
String formatRemaining(int seconds) {
  return seconds < 60 ? '${seconds}s' : formatCallDuration(seconds);
}

String formatCallDuration(int seconds) {
  final minutes = seconds ~/ 60;
  final remainder = (seconds % 60).toString().padLeft(2, '0');
  return '$minutes:$remainder';
}
