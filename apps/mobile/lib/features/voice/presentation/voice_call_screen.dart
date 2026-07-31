import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../shared/ui/haptics.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../../shared/ui/motion.dart';
import '../domain/voice_models.dart';
import 'voice_call_avatar.dart';
import 'voice_call_controller.dart';

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

  final String projectId;
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

  @override
  Widget build(BuildContext context) {
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
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 32, 24, 0),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      VoiceCallAvatar(
                        character: state.character ?? widget.character,
                        speaking: state.characterSpeaking,
                        connected: state.phase == VoiceCallPhase.connected,
                      ),
                      const SizedBox(height: 24),
                      Text(
                        (state.character ?? widget.character).name,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 6),
                      _CallStatusLine(state: state),
                      const SizedBox(height: 20),
                      Expanded(child: _CallTranscript(state: state)),
                    ],
                  ),
                ),
              ),
              _CallFooter(state: state, controller: controller),
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
      VoiceCallPhase.idle || VoiceCallPhase.ringing => ('Connecting…', colors.onSurfaceVariant),
      // The first call to a character builds their persona. Naming what is
      // happening beats a spinner that looks like a stuck connection.
      VoiceCallPhase.preparing => ('Waking $character up…', colors.onSurfaceVariant),
      VoiceCallPhase.connected => (formatCallDuration(state.elapsedSeconds), colors.onSurfaceVariant),
      VoiceCallPhase.reconnecting => ('Reconnecting…', colors.tertiary),
      VoiceCallPhase.ended => ('Call ended · ${formatCallDuration(state.elapsedSeconds)}', colors.onSurfaceVariant),
      VoiceCallPhase.failed => (state.error ?? 'The call could not connect.', colors.error),
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
          Text(
            switch (state.endingReason) {
              VoiceCallEndingReason.credits =>
                'Out of credits — ending in ${formatRemaining(state.secondsRemaining)}',
              VoiceCallEndingReason.limit =>
                'Call limit reached — ending in ${formatRemaining(state.secondsRemaining)}',
              null => 'Ending in ${formatRemaining(state.secondsRemaining)}',
            },
            style: theme.textTheme.labelMedium?.copyWith(color: colors.tertiary),
          ),
        ],
        if (state.phase == VoiceCallPhase.ended && state.chargedCredits > 0) ...[
          const SizedBox(height: 6),
          Text(
            '${state.chargedCredits} credits',
            style: theme.textTheme.labelMedium?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ],
    );
  }
}

class _CallTranscript extends StatefulWidget {
  const _CallTranscript({required this.state});

  final VoiceCallState state;

  @override
  State<_CallTranscript> createState() => _CallTranscriptState();
}

/// Keeps the newest line in view without ever taking the scroll away from the
/// reader.
///
/// Following the bottom of a feed that is being written to several times a
/// second is fiddlier than it looks, and each rule below is here because its
/// absence was visible:
///
/// * React to new *text*, not to rebuilds. The call timer ticks every second,
///   which rebuilds this widget; scrolling on that kicked the transcript once
///   a second through silence.
/// * Never stack animations. Transcription arrives as a stream of deltas, and
///   starting a fresh `animateTo` over a running one interrupts it — repeated
///   interruption is what read as stutter. A scroll asked for mid-flight is
///   remembered and run once the current one lands.
/// * Stop following the moment the reader scrolls away, and resume only when
///   they come back to the bottom themselves.
/// * Re-measure after every frame. The live caption grows as it is spoken, so
///   the extent captured when a scroll was scheduled is already short by the
///   time it runs.
class _CallTranscriptState extends State<_CallTranscript> {
  /// How close to the end still counts as "at the bottom", in logical pixels.
  static const _bottomSlack = 24.0;

  final _scrollController = ScrollController();

  /// Whether new lines should pull the view down. Off while the reader is
  /// looking at something further up.
  bool _following = true;
  bool _animating = false;
  bool _followQueued = false;
  bool _framePending = false;
  bool _userDragging = false;

  /// Whether anything has scrolled off the top yet. The fade is only drawn
  /// when there is something above to fade, so the first line of a short
  /// transcript is not rendered half-transparent.
  bool _contentAbove = false;

  @override
  void initState() {
    super.initState();
    // A transcript that already has lines when this mounts — a rebuilt screen,
    // a hot reload — should open at the newest line, not at the top of the
    // conversation.
    _scheduleFollow();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(_CallTranscript oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_transcriptChanged(oldWidget.state, widget.state)) {
      _scheduleFollow();
    }
  }

  /// Whether there is new text, as opposed to any other reason to rebuild.
  ///
  /// `captions` keeps its identity across a `copyWith` that did not touch it,
  /// so an identity check is both cheap and exact.
  static bool _transcriptChanged(VoiceCallState before, VoiceCallState after) {
    return !identical(before.captions, after.captions) ||
        !identical(before.liveCaptions, after.liveCaptions);
  }

  void _scheduleFollow() {
    if (!_following || _framePending) return;
    _framePending = true;
    // After the frame, so the line that triggered this has been laid out and
    // the extent we scroll to is the real one.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _framePending = false;
      _followBottom();
    });
  }

  void _followBottom() {
    if (!mounted || !_following || !_scrollController.hasClients) {
      _followQueued = false;
      return;
    }
    if (_animating) {
      // Land the current scroll first, then come back for whatever arrived.
      _followQueued = true;
      return;
    }

    final position = _scrollController.position;
    final target = position.maxScrollExtent;
    _followQueued = false;
    if ((target - position.pixels).abs() < 0.5) {
      return;
    }
    if (AppMotion.reducedMotion(context)) {
      _scrollController.jumpTo(target);
      return;
    }

    _animating = true;
    _scrollController
        .animateTo(target, duration: AppMotion.fast, curve: AppMotion.standard)
        .whenComplete(() {
          _animating = false;
          if (mounted && _followQueued) {
            _followBottom();
          }
        });
  }

  /// Hands control to the reader as soon as they touch the list, and takes it
  /// back only when they leave it at the bottom.
  bool _onScroll(ScrollNotification notification) {
    if (notification is ScrollStartNotification && notification.dragDetails != null) {
      _userDragging = true;
      _following = false;
    } else if (notification is ScrollUpdateNotification && notification.dragDetails != null) {
      _following = _isAtBottom(notification.metrics);
    } else if (notification is ScrollEndNotification && _userDragging) {
      // Only a scroll the reader drove decides this. A programmatic scroll can
      // end short of the bottom when a line landed mid-flight, and reading that
      // as "they scrolled away" would stop the transcript following for good.
      _userDragging = false;
      _following = _isAtBottom(notification.metrics);
      if (_following) {
        _scheduleFollow();
      }
    }

    final contentAbove = notification.metrics.pixels > 0.5;
    if (contentAbove != _contentAbove && mounted) {
      setState(() => _contentAbove = contentAbove);
    }
    return false;
  }

  static bool _isAtBottom(ScrollMetrics metrics) {
    return metrics.pixels >= metrics.maxScrollExtent - _bottomSlack;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final lines = [...widget.state.captions, ...widget.state.liveCaptions];
    if (lines.isEmpty) {
      return const SizedBox.shrink();
    }

    final list = NotificationListener<ScrollNotification>(
      onNotification: _onScroll,
      child: ListView.builder(
        controller: _scrollController,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: lines.length,
        itemBuilder: (context, index) {
          final caption = lines[index];
          final fromCaller = caption.speaker == VoiceCallSpeaker.caller;
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Align(
              alignment: fromCaller ? Alignment.centerRight : Alignment.centerLeft,
              child: Text(
                caption.text,
                textAlign: fromCaller ? TextAlign.right : TextAlign.left,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: fromCaller ? colors.onSurfaceVariant : colors.onSurface,
                  height: 1.35,
                ),
              ),
            ),
          );
        },
      ),
    );

    // The mask is always in the tree, and only its gradient changes. Adding or
    // removing a parent widget here instead would remount the list on the first
    // scroll and throw the reader's position away.
    return ShaderMask(
      // Fades lines out as they leave the top rather than clipping them, so
      // older text recedes instead of being chopped mid-word. Collapsed to a
      // no-op until something has actually scrolled off, so the opening line of
      // a short transcript is not rendered half-transparent for no reason.
      shaderCallback: (bounds) => LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: const [Colors.transparent, Colors.black, Colors.black],
        stops: _contentAbove ? const [0, 0.18, 1] : const [0, 0, 1],
      ).createShader(bounds),
      blendMode: BlendMode.dstIn,
      child: list,
    );
  }
}

class _CallFooter extends StatelessWidget {
  const _CallFooter({required this.state, required this.controller});

  final VoiceCallState state;
  final VoiceCallController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final finished = state.phase == VoiceCallPhase.ended || state.phase == VoiceCallPhase.failed;

    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Required disclosure, and honest: this is a synthesised voice, not a
          // recording of a person.
          Text(
            'AI voice',
            style: theme.textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          const SizedBox(height: 16),
          if (finished)
            _FinishedCallActions(state: state)
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
                    await controller.hangUp();
                    if (context.mounted) Navigator.of(context).pop();
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
    );
  }
}

/// What the caller is offered once the line has gone.
///
/// A call that ended on its own has to say why. "Call ended" alone reads as a
/// fault when it was really the meter, and a caller who ran out of credits
/// should not have to go hunting through the account screen to fix it.
class _FinishedCallActions extends StatelessWidget {
  const _FinishedCallActions({required this.state});

  final VoiceCallState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final outOfCredits = state.endedBecause == VoiceCallEndingReason.credits;
    final explanation = switch (state.endedBecause) {
      VoiceCallEndingReason.credits => 'The call ended when your credits ran out.',
      VoiceCallEndingReason.limit =>
        'Calls stop at ${state.maxCallSeconds ~/ 60} minutes. Call again to keep talking.',
      null => null,
    };

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (explanation != null) ...[
          Text(
            explanation,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 14),
        ],
        if (outOfCredits) ...[
          FilledButton.icon(
            onPressed: () {
              AppHaptics.tap();
              showBillingPaywall(
                context,
                projectId: state.character?.projectId,
                message: 'Add credits to keep talking to your characters.',
              );
            },
            icon: const Icon(Icons.add_card_outlined),
            label: const Text('Add credits'),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: () {
              AppHaptics.tap();
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.arrow_back),
            label: const Text('Back to the book'),
          ),
        ] else
          FilledButton.icon(
            onPressed: () {
              AppHaptics.tap();
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.arrow_back),
            label: const Text('Back to the book'),
          ),
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
                  child: Icon(icon, color: foreground, size: destructive ? 30 : 26),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
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
