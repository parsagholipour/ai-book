import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../projects/presentation/credit_cost_badge.dart';
import '../data/audiobook_cache.dart';
import '../data/audiobook_repository.dart';
import '../domain/audiobook_models.dart';
import 'narrator_preview_source.dart';

/// Choosing a narrator.
///
/// Voices are impossible to judge from a name, so every one can be heard before
/// any credits are spent — the samples are free and shared across all books.
/// The price sits on the confirm button as the same tappable badge used
/// everywhere else, rather than being spelled out in prose.
Future<bool> showNarratorPickerSheet(
  BuildContext context, {
  required String projectId,
  required int pageCount,
  required bool replacing,
  required Future<bool> Function(String voice) onConfirm,
}) async {
  final started = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _NarratorPickerSheet(
      projectId: projectId,
      pageCount: pageCount,
      replacing: replacing,
      onConfirm: onConfirm,
    ),
  );
  return started ?? false;
}

class _NarratorPickerSheet extends ConsumerStatefulWidget {
  const _NarratorPickerSheet({
    required this.projectId,
    required this.pageCount,
    required this.replacing,
    required this.onConfirm,
  });

  final String projectId;
  final int pageCount;
  final bool replacing;
  final Future<bool> Function(String voice) onConfirm;

  @override
  ConsumerState<_NarratorPickerSheet> createState() =>
      _NarratorPickerSheetState();
}

class _NarratorPickerSheetState extends ConsumerState<_NarratorPickerSheet> {
  /// Only for previews. The audiobook itself plays through the controller's
  /// player, which owns the media session.
  final AudioPlayer _preview = AudioPlayer();
  String? _selected;
  String? _loadingPreview;
  String? _previewing;
  int _previewRequest = 0;
  bool _starting = false;

  @override
  void dispose() {
    _preview.dispose();
    super.dispose();
  }

  Future<void> _playSample(NarratorVoice voice) async {
    AppHaptics.selection();
    if (_previewing == voice.voice || _loadingPreview == voice.voice) {
      _previewRequest += 1;
      await _preview.stop();
      if (mounted) {
        setState(() {
          _loadingPreview = null;
          _previewing = null;
        });
      }
      return;
    }

    final request = ++_previewRequest;
    setState(() {
      _loadingPreview = voice.voice;
      _previewing = null;
    });
    try {
      await _preview.stop();
      final sample = await ref
          .read(audiobookCacheProvider)
          .ensureNarratorSample(voice);
      if (!mounted || request != _previewRequest) {
        return;
      }
      // just_audio_background wraps every AudioPlayer in the app and rejects
      // sources without a MediaItem tag before Android ever receives the file.
      // The old setFilePath call omitted this, so the valid cached MP3 failed
      // during loading and ExoPlayer never opened an audio track.
      await _preview.setAudioSource(narratorPreviewSource(voice, sample.path));
      if (!mounted || request != _previewRequest) {
        return;
      }
      setState(() {
        _loadingPreview = null;
        _previewing = voice.voice;
      });
      await _preview.play();
    } catch (error, stackTrace) {
      debugPrint('Narrator preview failed for ${voice.voice}: $error');
      debugPrintStack(stackTrace: stackTrace);
      if (mounted && request == _previewRequest) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              content: Text(
                "${voice.name}'s preview could not be played. Please try again.",
              ),
            ),
          );
      }
    }
    if (mounted && request == _previewRequest) {
      setState(() {
        _loadingPreview = null;
        _previewing = null;
      });
    }
  }

  Future<void> _confirm(int credits) async {
    final voice = _selected;
    if (voice == null || _starting) {
      return;
    }
    _previewRequest += 1;
    setState(() {
      _starting = true;
      _loadingPreview = null;
      _previewing = null;
    });
    await _preview.stop();
    final started = await widget.onConfirm(voice);
    if (!mounted) {
      return;
    }
    if (started) {
      AppHaptics.success();
      Navigator.of(context).pop(true);
    } else {
      setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final voices = ref.watch(narratorVoicesProvider);
    final billing = ref.watch(billingProvider).asData?.value;
    final credits = _priceFor(
      billing?.creditCosts ?? const {},
      widget.pageCount,
    );
    final available = billing?.credits.available ?? 0;
    final canAfford = available >= credits;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.86,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, scrollController) {
        return Column(
          children: [
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
                children: [
                  _PickerHero(replacing: widget.replacing),
                  const SizedBox(height: 18),
                  voices.when(
                    loading: () => const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: AppLoadingState(message: 'Gathering narrators'),
                    ),
                    error: (error, _) => AppErrorState(
                      title: 'Narrators unavailable',
                      message: 'We could not load the narrators.',
                      onRetry: () => ref.invalidate(narratorVoicesProvider),
                    ),
                    data: (list) => Column(
                      children: [
                        for (final (index, voice) in list.indexed)
                          AppEntrance(
                            index: index,
                            child: Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _NarratorCard(
                                voice: voice,
                                selected: _selected == voice.voice,
                                loading: _loadingPreview == voice.voice,
                                playing: _previewing == voice.voice,
                                onSelect: () {
                                  AppHaptics.selection();
                                  setState(() => _selected = voice.voice);
                                },
                                onPreview: () => _playSample(voice),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            _PickerFooter(
              credits: credits,
              canAfford: canAfford,
              enabled: _selected != null && !_starting,
              busy: _starting,
              onConfirm: () => _confirm(credits),
              onTopUp: () => showBillingPaywall(
                context,
                projectId: widget.projectId,
                message: 'Add credits to have your book read aloud.',
              ),
              backgroundColor: colors.surfaceContainerLowest,
            ),
          ],
        );
      },
    );
  }

  /// Mirrors the server's `audiobookBase + audiobookPerPage × pages`, reading
  /// the live prices the billing endpoint ships so a price change needs no
  /// client release.
  static int _priceFor(Map<String, dynamic> creditCosts, int pageCount) {
    int cost(String key, int fallback) {
      final value = creditCosts[key];
      return value is num ? value.round() : fallback;
    }

    return cost('audiobookBase', 80) + pageCount * cost('audiobookPerPage', 12);
  }
}

class _PickerHero extends StatelessWidget {
  const _PickerHero({required this.replacing});

  final bool replacing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TomezaRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.22)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colors.primary.withValues(alpha: 0.20),
            colors.tertiary.withValues(alpha: 0.08),
            colors.surfaceContainerLowest,
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              gradient: LinearGradient(
                colors: [colors.primary, colors.tertiary],
              ),
            ),
            child: Icon(Icons.graphic_eq, color: colors.onPrimary),
          ),
          const SizedBox(height: 14),
          Text(
            replacing ? 'Choose a new narrator' : 'Choose your narrator',
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            replacing
                ? 'This replaces the current audiobook. Tap a voice to hear it first — previews are free.'
                : 'Tap a voice to hear it read a few lines. Previews are free; you only pay when you start.',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _NarratorCard extends StatelessWidget {
  const _NarratorCard({
    required this.voice,
    required this.selected,
    required this.loading,
    required this.playing,
    required this.onSelect,
    required this.onPreview,
  });

  final NarratorVoice voice;
  final bool selected;
  final bool loading;
  final bool playing;
  final VoidCallback onSelect;
  final VoidCallback onPreview;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Material(
      color: selected
          ? colors.primaryContainer.withValues(alpha: 0.55)
          : colors.surfaceContainerLowest,
      borderRadius: BorderRadius.circular(TomezaRadii.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onSelect,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(TomezaRadii.card),
            border: Border.all(
              color: selected ? colors.primary : colors.outlineVariant,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            children: [
              _PreviewButton(
                loading: loading,
                playing: playing,
                onPressed: onPreview,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      voice.name,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      voice.blurb,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(
                selected ? Icons.check_circle : Icons.circle_outlined,
                color: selected ? colors.primary : colors.outlineVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PreviewButton extends StatelessWidget {
  const _PreviewButton({
    required this.loading,
    required this.playing,
    required this.onPressed,
  });

  final bool loading;
  final bool playing;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: loading
          ? 'Cancel preview loading'
          : playing
          ? 'Stop preview'
          : 'Play preview',
      child: ExcludeSemantics(
        child: Material(
          color: colors.primary.withValues(alpha: playing ? 0.24 : 0.10),
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox(
              width: 46,
              height: 46,
              child: loading
                  ? Padding(
                      padding: const EdgeInsets.all(13),
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: colors.primary,
                      ),
                    )
                  : Icon(
                      playing ? Icons.stop_rounded : Icons.play_arrow_rounded,
                      color: colors.primary,
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PickerFooter extends StatelessWidget {
  const _PickerFooter({
    required this.credits,
    required this.canAfford,
    required this.enabled,
    required this.busy,
    required this.onConfirm,
    required this.onTopUp,
    required this.backgroundColor,
  });

  final int credits;
  final bool canAfford;
  final bool enabled;
  final bool busy;
  final VoidCallback onConfirm;
  final VoidCallback onTopUp;
  final Color backgroundColor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: backgroundColor,
      padding: EdgeInsets.fromLTRB(
        18,
        12,
        18,
        18 + MediaQuery.viewPaddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                'Narrating this book costs',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(width: 8),
              CreditCostBadge(credits: credits, kind: CreditCostKind.quoted),
            ],
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: canAfford
                ? FilledButton.icon(
                    onPressed: enabled ? onConfirm : null,
                    icon: busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.headphones),
                    label: Text(busy ? 'Starting…' : 'Start narrating'),
                  )
                : FilledButton.icon(
                    onPressed: onTopUp,
                    icon: const Icon(Icons.add),
                    label: const Text('Add credits'),
                  ),
          ),
        ],
      ),
    );
  }
}
