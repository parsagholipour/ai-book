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
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../domain/audiobook_models.dart';
import '../domain/audiobook_timeline.dart';
import 'audiobook_controller.dart';
import 'narrator_picker_sheet.dart';

part 'audiobook_screen_controls.dart';
part 'audiobook_screen_transcript.dart';

/// The listening screen.
///
/// One book, one timeline, one play button — even while the narration is still
/// being made behind it. The transcript below follows along sentence by
/// sentence and can be tapped to jump, which is the part that makes this feel
/// less like a media player and more like reading with your ears.
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

    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surfaceContainerLowest,
      appBar: AppBar(
        title: const Text('Listen'),
        actions: [
          if (state.hasAudiobook)
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
              ),
            ),
          if (state.hasAudiobook)
            IconButton(
              tooltip: 'Change narrator',
              onPressed: () => _openPicker(detail, replacing: true),
              icon: const Icon(Icons.record_voice_over_outlined),
            ),
        ],
      ),
      body: SafeArea(child: _body(state, detail)),
    );
  }

  Widget _body(AudiobookState state, MobileProjectDetail? detail) {
    if (state.loading) {
      return const AppLoadingState(message: 'Looking for your audiobook');
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
        onStart: () => _openPicker(detail, replacing: false),
        busy: state.starting,
      );
    }

    final audiobook = state.audiobook!;
    if (audiobook.hasFailed) {
      return AppErrorState(
        title: 'Narration stopped',
        message:
            audiobook.failureMessage ??
            'The narration did not finish. Your credits were refunded.',
        actionLabel: 'Try again',
        onRetry: () => _openPicker(detail, replacing: true),
      );
    }
    if (!state.canPlay) {
      return _PreparingNarration(audiobook: audiobook);
    }

    return Column(
      children: [
        _NowPlayingHeader(
          bookTitle: detail?.title ?? 'Your book',
          audiobook: audiobook,
          coverUrl: detail?.coverImage?.url,
          compact: _showTranscript,
        ),
        if (_showTranscript)
          Expanded(
            child: _TranscriptPane(
              projectId: widget.projectId,
              timeline: state.activeTimeline,
              activeSegmentIndex: state.activeSegmentIndex,
            ),
          )
        else
          const Spacer(),
        _PlayerControls(projectId: widget.projectId, state: state),
      ],
    );
  }

  Future<void> _openPicker(
    MobileProjectDetail? detail, {
    required bool replacing,
  }) async {
    final controller = ref.read(
      audiobookControllerProvider(widget.projectId).notifier,
    );
    await showNarratorPickerSheet(
      context,
      projectId: widget.projectId,
      pageCount: detail?.pageCount ?? detail?.targetPages ?? 0,
      replacing: replacing,
      onConfirm: (voice) =>
          controller.narrate(voice: voice, replace: replacing),
    );
  }
}

class _NotNarratedYet extends StatelessWidget {
  const _NotNarratedYet({required this.onStart, required this.busy});

  final VoidCallback onStart;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return AppEmptyState(
      icon: Icons.headphones,
      title: 'Hear your book read aloud',
      message:
          'Pick a narrator and we will read the whole book to you. The first chapter is usually ready within a couple of minutes.',
      actionLabel: busy ? 'Starting…' : 'Choose a narrator',
      onAction: busy ? null : onStart,
    );
  }
}

/// The gap between paying and the first chapter landing. It is short, but it is
/// the moment someone is most likely to wonder whether anything happened.
class _PreparingNarration extends StatelessWidget {
  const _PreparingNarration({required this.audiobook});

  final MobileAudiobook audiobook;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final progress = audiobook.progress;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AppShimmer(
              child: Container(
                width: 92,
                height: 92,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: colors.primary.withValues(alpha: 0.16),
                ),
                child: Icon(Icons.graphic_eq, size: 40, color: colors.primary),
              ),
            ),
            const SizedBox(height: 24),
            Text(
              '${audiobook.narratorName} is warming up',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              progress?.currentAction ?? 'Preparing narration',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            if (audiobook.backupNarrationUsed) ...[
              const SizedBox(height: 6),
              Text(
                'Generated with backup narration',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ],
            const SizedBox(height: 20),
            AppAnimatedProgressBar(
              value: progress == null || progress.chapterCount == 0
                  ? 0
                  : progress.chaptersReady / progress.chapterCount,
              semanticLabel: 'Narration progress',
            ),
            const SizedBox(height: 14),
            Text(
              'You can leave this screen — we will keep narrating.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
