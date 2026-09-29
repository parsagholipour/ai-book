import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../projects/presentation/credit_cost_badge.dart';
import '../data/audiobook_cache.dart';
import '../data/audiobook_repository.dart';
import '../domain/audiobook_models.dart';
import 'audio_sound_bars.dart';
import 'narrator_preview_source.dart';

/// Choosing a narrator.
///
/// Voices are impossible to judge from a name, so every one can be heard before
/// any credits are spent — the samples are free and shared across all books.
/// The price sits on the confirm button's line as the same tappable badge used
/// everywhere else, rather than being spelled out in prose, and only when the
/// billing payload has actually quoted one.
///
/// [currentVoice] marks the narrator a replacement would replace. [onConfirm]
/// returns null once the narration is under way, or the reason it could not
/// start — the sheet is covering the listening screen, so it has to deliver
/// that message itself.
Future<bool> showNarratorPickerSheet(
  BuildContext context, {
  required String projectId,
  required int pageCount,
  required bool replacing,
  required Future<String?> Function(String voice) onConfirm,
  String? currentVoice,
}) async {
  final started = await showAppBottomSheet<bool>(
    context,
    builder: (_) => _NarratorPickerSheet(
      projectId: projectId,
      pageCount: pageCount,
      replacing: replacing,
      currentVoice: currentVoice,
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
    required this.currentVoice,
    required this.onConfirm,
  });

  final String projectId;
  final int pageCount;
  final bool replacing;
  final String? currentVoice;
  final Future<String?> Function(String voice) onConfirm;

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
          ..showAppSnackBar(
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

  Future<void> _confirm() async {
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
    final failure = await widget.onConfirm(voice);
    if (!mounted) {
      return;
    }
    if (failure == null) {
      AppHaptics.success();
      Navigator.of(context).pop(true);
      return;
    }
    // Silence here reads as the button doing nothing at all: the sheet stays
    // up, so the screen behind can never deliver the reason.
    AppHaptics.error();
    setState(() => _starting = false);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showAppSnackBar(SnackBar(content: Text(failure)));
  }

  @override
  Widget build(BuildContext context) {
    final voices = ref.watch(narratorVoicesProvider);
    final billing = ref.watch(billingProvider).asData?.value;
    final credits = _priceFor(
      billing?.creditCosts ?? const {},
      widget.pageCount,
    );
    // An unquoted price is not a price of zero and not a price we can check the
    // balance against: the server has the final say, and says so out loud.
    final canAfford =
        credits == null ||
        billing == null ||
        billing.credits.available >= credits;
    final selectedName = voices.asData?.value
        .where((voice) => voice.voice == _selected)
        .firstOrNull
        ?.name;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.9,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (context, scrollController) {
        return Column(
          children: [
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                children: [
                  _PickerHeader(replacing: widget.replacing),
                  const SizedBox(height: 16),
                  voices.when(
                    loading: () => const _VoiceSkeletons(),
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
                                current: voice.voice == widget.currentVoice,
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
              selectedName: selectedName,
              credits: credits,
              canAfford: canAfford,
              enabled: _selected != null && !_starting,
              busy: _starting,
              onConfirm: _confirm,
              onTopUp: () => showBillingPaywall(
                context,
                projectId: widget.projectId,
                message: 'Add credits to have your book read aloud.',
              ),
            ),
          ],
        );
      },
    );
  }

  /// Mirrors the server's `audiobookBase + audiobookPerPage × pages`, reading
  /// the live prices the billing endpoint ships so a price change needs no
  /// client release. Null when either price has not been shipped: the app does
  /// not guess one.
  static int? _priceFor(Map<String, dynamic> creditCosts, int pageCount) {
    final base = creditCosts['audiobookBase'];
    final perPage = creditCosts['audiobookPerPage'];
    if (base is! num || perPage is! num) {
      return null;
    }
    return base.round() + pageCount * perPage.round();
  }
}

class _PickerHeader extends StatelessWidget {
  const _PickerHeader({required this.replacing});

  final bool replacing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  colors.primary,
                  Color.lerp(colors.primary, colors.tertiary, 0.6)!,
                ],
              ),
            ),
            child: Icon(Icons.graphic_eq, color: colors.onPrimary),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  replacing ? 'Choose a new narrator' : 'Choose your narrator',
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                replacing
                    ? 'This replaces the current audiobook. Press play on a voice to hear it first — previews are free.'
                    : 'Press play on a voice to hear it read a few lines. Previews are free; you only pay when you start.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Cards in the shape of the real ones while the list of voices is on its way.
class _VoiceSkeletons extends StatelessWidget {
  const _VoiceSkeletons();

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
      label: 'Gathering narrators',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Column(
            children: [
              for (var i = 0; i < 4; i += 1)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(AppRadii.card),
                      border: Border.all(color: colors.outlineVariant),
                    ),
                    child: Row(
                      children: [
                        block(48, 48, radius: 24),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              block(110, 16),
                              const SizedBox(height: 8),
                              block(190, 12),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        block(24, 24, radius: 12),
                      ],
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

/// One voice: a button to hear it, its name and character, and a mark that says
/// whether it is the one that will narrate.
///
/// The two things are separate controls on purpose. Hearing a voice is free and
/// can be done as often as you like; choosing it is what the price attaches to.
class _NarratorCard extends StatelessWidget {
  const _NarratorCard({
    required this.voice,
    required this.current,
    required this.selected,
    required this.loading,
    required this.playing,
    required this.onSelect,
    required this.onPreview,
  });

  final NarratorVoice voice;
  final bool current;
  final bool selected;
  final bool loading;
  final bool playing;
  final VoidCallback onSelect;
  final VoidCallback onPreview;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final heardNow = loading || playing;
    return AnimatedContainer(
      duration: AppMotion.fast,
      decoration: BoxDecoration(
        color: selected
            ? colors.primaryContainer.withValues(alpha: 0.55)
            : colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(
          color: selected ? colors.primary : colors.outlineVariant,
          width: selected ? 1.5 : 1,
        ),
      ),
      child: Row(
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 10),
            child: _PreviewButton(
              voiceName: voice.name,
              loading: loading,
              playing: playing,
              onPressed: onPreview,
            ),
          ),
          Expanded(
            child: Semantics(
              button: true,
              inMutuallyExclusiveGroup: true,
              checked: selected,
              label:
                  '${voice.name}${current ? ', current narrator' : ''}. ${voice.blurb}',
              onTap: onSelect,
              child: ExcludeSemantics(
                child: InkWell(
                  borderRadius: BorderRadius.circular(AppRadii.card),
                  onTap: onSelect,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 76),
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(
                        14,
                        12,
                        14,
                        12,
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Wrap(
                                  spacing: 8,
                                  runSpacing: 2,
                                  crossAxisAlignment: WrapCrossAlignment.center,
                                  children: [
                                    Text(
                                      voice.name,
                                      style: theme.textTheme.titleMedium
                                          ?.copyWith(
                                            fontWeight: FontWeight.w700,
                                          ),
                                    ),
                                    if (current)
                                      const AppStatusBadge(
                                        label: 'Current',
                                        icon: Icons.check,
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  voice.blurb,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: colors.onSurfaceVariant,
                                  ),
                                ),
                                // Says what the button beside it is doing, so a
                                // sample that takes a moment to arrive does
                                // not read as a button that did nothing.
                                AnimatedSize(
                                  duration: AppMotion.fast,
                                  alignment: AlignmentDirectional.topStart,
                                  child: heardNow
                                      ? Padding(
                                          padding: const EdgeInsets.only(
                                            top: 6,
                                          ),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              AudioSoundBars(
                                                active: playing,
                                                color: colors.primary,
                                                size: 14,
                                              ),
                                              const SizedBox(width: 8),
                                              Text(
                                                loading
                                                    ? 'Loading sample…'
                                                    : 'Playing sample',
                                                style: theme
                                                    .textTheme
                                                    .labelMedium
                                                    ?.copyWith(
                                                      color: colors.primary,
                                                      fontWeight:
                                                          FontWeight.w700,
                                                    ),
                                              ),
                                            ],
                                          ),
                                        )
                                      : const SizedBox(width: double.infinity),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          Icon(
                            selected
                                ? Icons.check_circle
                                : Icons.circle_outlined,
                            color: selected ? colors.primary : colors.outline,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PreviewButton extends StatelessWidget {
  const _PreviewButton({
    required this.voiceName,
    required this.loading,
    required this.playing,
    required this.onPressed,
  });

  final String voiceName;
  final bool loading;
  final bool playing;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: loading
          ? 'Cancel loading $voiceName preview'
          : playing
          ? 'Stop $voiceName preview'
          : 'Play $voiceName preview',
      onTap: onPressed,
      child: ExcludeSemantics(
        child: Material(
          // Filled while it is the one making sound, so of several voices the
          // one that is playing is the one that stands out.
          color: playing
              ? colors.primary
              : colors.primary.withValues(alpha: 0.10),
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox.square(
              dimension: AppSizes.minimumTouchTarget + 4,
              child: loading
                  ? Padding(
                      padding: const EdgeInsets.all(14),
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: colors.primary,
                      ),
                    )
                  : Icon(
                      playing ? Icons.stop_rounded : Icons.play_arrow_rounded,
                      size: 28,
                      color: playing ? colors.onPrimary : colors.primary,
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
    required this.selectedName,
    required this.credits,
    required this.canAfford,
    required this.enabled,
    required this.busy,
    required this.onConfirm,
    required this.onTopUp,
  });

  final String? selectedName;
  final int? credits;
  final bool canAfford;
  final bool enabled;
  final bool busy;
  final VoidCallback onConfirm;
  final VoidCallback onTopUp;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 14),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        selectedName == null
                            ? 'Pick a voice to continue'
                            : 'Narrated by $selectedName',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      if (credits != null)
                        Text(
                          'Narrating this book costs',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                if (credits != null) ...[
                  const SizedBox(width: 8),
                  CreditCostBadge(
                    credits: credits!,
                    kind: CreditCostKind.quoted,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 12),
            if (canAfford)
              AppButton.primary(
                label: 'Start narrating',
                loadingLabel: 'Starting…',
                loading: busy,
                onPressed: enabled ? onConfirm : null,
                leading: const Icon(Icons.headphones),
                expanded: true,
              )
            else
              AppButton.primary(
                label: 'Add credits',
                onPressed: onTopUp,
                leading: const Icon(Icons.add),
                expanded: true,
              ),
          ],
        ),
      ),
    );
  }
}
