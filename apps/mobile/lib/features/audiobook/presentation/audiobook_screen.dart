import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
// The transcript scrolls to paragraphs the lazy list has not built yet, which
// means measuring the ones it has against the viewport itself.
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/book_cover.dart';
import '../../projects/presentation/plan_build_progress.dart';
import '../domain/audiobook_models.dart';
import '../domain/audiobook_timeline.dart';
import 'audio_sound_bars.dart';
import 'audiobook_controller.dart';
import 'audiobook_plan_offer.dart';
import 'narrator_picker_sheet.dart';

part 'audiobook_screen_controls.dart';
part 'audiobook_screen_header.dart';
part 'audiobook_screen_scrubber.dart';
part 'audiobook_screen_sheets.dart';
part 'audiobook_screen_states.dart';
part 'audiobook_screen_transcript.dart';

/// The listening screen.
///
/// One book, one timeline, one play button — even while the narration is still
/// being made behind it. The transcript below follows along sentence by
/// sentence and can be tapped to jump, which is the part that makes this feel
/// less like a media player and more like reading with your ears.
///
/// Two layouts share one set of controls. With the transcript open the cover
/// shrinks to a strip and the words take the room; with it closed (or when the
/// screen is too short for the words to be worth reading) the cover is the
/// centrepiece and moves gently while there is sound.
class AudiobookScreen extends ConsumerStatefulWidget {
  const AudiobookScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<AudiobookScreen> createState() => _AudiobookScreenState();
}

class _AudiobookScreenState extends ConsumerState<AudiobookScreen> {
  bool _showTranscript = true;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(audiobookControllerProvider(widget.projectId));
    final detail = ref
        .watch(projectDetailProvider(widget.projectId))
        .asData
        ?.value;

    // The lock-screen notification needs a title and cover; the controller has
    // neither until the project detail lands.
    if (detail != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          ref
              .read(audiobookControllerProvider(widget.projectId).notifier)
              .attachBookDetails(
                title: detail.title,
                coverUrl: detail.coverImage?.url,
              );
        }
      });
    }

    final audiobook = state.audiobook;
    final listening =
        audiobook != null && !audiobook.hasFailed && state.canPlay;
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      backgroundColor: colors.surfaceContainerLowest,
      appBar: AppBar(
        title: const Text('Listen'),
        backgroundColor: colors.surfaceContainerLowest,
        actions: [
          if (listening)
            IconButton(
              tooltip: _showTranscript ? 'Hide transcript' : 'Show transcript',
              onPressed: () {
                AppHaptics.tap();
                setState(() => _showTranscript = !_showTranscript);
              },
              icon: Icon(
                _showTranscript
                    ? Icons.subtitles
                    : Icons.subtitles_off_outlined,
                color: _showTranscript ? colors.primary : null,
              ),
            ),
          if (state.hasAudiobook && !state.offline)
            IconButton(
              tooltip: 'Change narrator',
              onPressed: () => _openPicker(replacing: true),
              icon: const Icon(Icons.record_voice_over_outlined),
            ),
        ],
      ),
      body: SafeArea(
        child: _Crossfade(
          reduced: AppMotion.reducedMotion(context),
          child: KeyedSubtree(
            key: ValueKey(_stageOf(state)),
            child: _body(state, detail),
          ),
        ),
      ),
    );
  }

  /// Which screen the state is on. Only a change of *kind* cross-fades: the
  /// player rebuilds on every position tick and must not restart a transition.
  String _stageOf(AudiobookState state) {
    final audiobook = state.audiobook;
    if (state.loading) {
      return 'loading';
    }
    if (audiobook == null) {
      return state.error != null ? 'load-error' : 'empty';
    }
    if (audiobook.hasFailed) {
      return 'failed';
    }
    if (!state.canPlay) {
      return state.offline
          ? 'offline-empty'
          : state.error != null
          ? 'download-error'
          : 'preparing';
    }
    return 'player';
  }

  Widget _body(AudiobookState state, MobileProjectDetail? detail) {
    if (state.loading) {
      return const _PlayerSkeleton();
    }
    // Offline with nothing to play: the narration was never downloaded here.
    // Said as a fact about the phone, never as narration being made now.
    if (state.offline && state.hasAudiobook && !state.canPlay) {
      return _NotOnThisPhone(
        onRetry: () => ref
            .read(audiobookControllerProvider(widget.projectId).notifier)
            .retry(),
      );
    }
    if (!state.hasAudiobook) {
      // A failed load must not masquerade as "never narrated" — that offers to
      // sell a narration the server cannot even read back.
      final error = state.error;
      if (error != null) {
        return AppErrorState(
          title: 'Narration unavailable',
          message: error,
          onRetry: () => ref
              .read(audiobookControllerProvider(widget.projectId).notifier)
              .retry(),
        );
      }
      return _NotNarratedYet(
        onStart: () => _openPicker(replacing: false),
        busy: state.starting,
        planLocked: audiobooksLockedByPlan(
          ref.watch(billingProvider).asData?.value,
        ),
      );
    }

    final audiobook = state.audiobook!;
    if (audiobook.hasFailed) {
      return _NarrationStopped(
        message:
            audiobook.failureMessage ??
            'The narration did not finish. Your credits were refunded.',
        onChooseNarrator: () => _openPicker(replacing: true),
      );
    }
    if (!state.canPlay) {
      // A failed chapter download must not hide behind "warming up": once the
      // narration has settled nothing polls, so without a retry here the
      // screen would say preparing forever.
      final error = state.error;
      if (error != null) {
        return AppErrorState(
          title: 'Download interrupted',
          message: error,
          onRetry: () => ref
              .read(audiobookControllerProvider(widget.projectId).notifier)
              .retry(),
        );
      }
      return _PreparingNarration(audiobook: audiobook);
    }

    return Column(
      children: [
        if (audiobook.isStale && !state.offline)
          _StaleBanner(onRenarrate: () => _openPicker(replacing: true)),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scale = _textScaleOf(context);
              // The words need room to be worth reading. Below this the cover
              // layout takes over, which scrolls rather than overflowing at
              // large text sizes or in landscape.
              final transcriptFits =
                  constraints.maxHeight >= _compactHeaderExtent(scale) + 150;
              if (_showTranscript && transcriptFits) {
                return Column(
                  children: [
                    _NowPlayingHeader.compact(
                      state: state,
                      bookTitle: detail?.title ?? 'Your book',
                      bookId: widget.projectId,
                      authorName: detail?.authorName,
                      coverImage: detail?.coverImage,
                      onChapters: () => _openChapters(),
                    ),
                    Expanded(
                      child: _TranscriptPane(
                        projectId: widget.projectId,
                        timeline: state.activeTimeline,
                        activeSegmentIndex: state.activeSegmentIndex,
                        showHint: state.globalPositionMs == 0 && !state.playing,
                      ),
                    ),
                  ],
                );
              }
              return Center(
                child: SingleChildScrollView(
                  child: _NowPlayingHeader.large(
                    state: state,
                    bookTitle: detail?.title ?? 'Your book',
                    bookId: widget.projectId,
                    authorName: detail?.authorName,
                    coverImage: detail?.coverImage,
                    onChapters: () => _openChapters(),
                    maxHeight: constraints.maxHeight,
                  ),
                ),
              );
            },
          ),
        ),
        _PlayerControls(projectId: widget.projectId, state: state),
      ],
    );
  }

  void _openChapters() {
    showAudiobookChaptersSheet(context, projectId: widget.projectId);
  }

  Future<void> _openPicker({required bool replacing}) async {
    // Narrating is a plan perk: a free reader is offered the plans instead of
    // a picker whose confirm the server would refuse. Listening is not gated.
    if (audiobooksLockedByPlan(ref.read(billingProvider).asData?.value)) {
      await showAudiobookPlanOffer(context, ref, projectId: widget.projectId);
      return;
    }
    final controller = ref.read(
      audiobookControllerProvider(widget.projectId).notifier,
    );
    final currentVoice = ref
        .read(audiobookControllerProvider(widget.projectId))
        .audiobook
        ?.voice;
    await showNarratorPickerSheet(
      context,
      projectId: widget.projectId,
      replacing: replacing,
      currentVoice: replacing ? currentVoice : null,
      onConfirm: (voice) async {
        final failure = await controller.narrate(
          voice: voice,
          replace: replacing,
        );
        // A refusal may be the plan lock seen through stale billing: re-read
        // it, so the next tap opens the plans rather than the picker again.
        if (failure != null) ref.invalidate(billingProvider);
        return failure;
      },
    );
  }
}

/// How much bigger than the design size the reader's text is.
double _textScaleOf(BuildContext context) =>
    math.max(1, MediaQuery.textScalerOf(context).scale(16) / 16);

/// Room the compact now-playing strip needs, before the transcript gets any.
double _compactHeaderExtent(double scale) => math.max(96, 66 * scale + 26);

/// Cross-fades between screens of different kinds and holds still otherwise.
class _Crossfade extends StatelessWidget {
  const _Crossfade({required this.child, required this.reduced});

  final Widget child;
  final bool reduced;

  @override
  Widget build(BuildContext context) {
    if (reduced) {
      return child;
    }
    return AnimatedSwitcher(
      duration: AppMotion.medium,
      switchInCurve: AppMotion.enter,
      switchOutCurve: AppMotion.exit,
      layoutBuilder: (current, previous) =>
          Stack(fit: StackFit.expand, children: [...previous, ?current]),
      child: child,
    );
  }
}
