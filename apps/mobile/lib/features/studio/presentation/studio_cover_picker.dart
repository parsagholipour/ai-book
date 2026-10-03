import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/media/photo_picker.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/presentation/plan_build_progress.dart';
import '../data/studio_repository.dart';
import '../domain/assist_models.dart';
import '../domain/manuscript_models.dart';
import '../domain/studio_pricing.dart';
import 'studio_cover_image.dart';
import 'studio_location.dart';
import 'studio_progress.dart';
import '../../billing/domain/billing_models.dart';

/// Opens the cover choice on a sheet of its own: from the book page, for a
/// book that is already published or still being written.
Future<void> showStudioCoverSheet(
  BuildContext context, {
  required String projectId,
  Manuscript? manuscript,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (sheetContext) => AppSheetScaffold(
      title: 'Cover',
      subtitle: 'The first thing a reader sees.',
      icon: Icons.image_outlined,
      onClose: () => Navigator.of(sheetContext).pop(),
      children: [
        StudioCoverPicker(projectId: projectId, manuscript: manuscript),
      ],
    ),
  );
}

/// How often a cover being made is looked at again.
const studioCoverPollInterval = Duration(seconds: 4);

enum _CoverTask { designing, uploading, generating }

/// The book's cover and the three ways to have one: designed from the title
/// (free, and the default), the author's own picture, or one drawn by AI.
///
/// Every choice applies at once — there is nothing to confirm but the paid
/// one. A cover being made shows its progress where the author is looking and
/// is re-read every [studioCoverPollInterval] until it lands.
///
/// [collapsible] starts as one quiet row with a Change link (the first
/// publish, where the designed default is the whole decision for most
/// people); otherwise the choices are laid out from the start.
class StudioCoverPicker extends ConsumerStatefulWidget {
  const StudioCoverPicker({
    required this.projectId,
    this.manuscript,
    this.collapsible = false,
    this.onChanged,
    this.onBusyChanged,
    super.key,
  });

  final String projectId;

  /// The working copy when the caller already has it; loaded otherwise.
  final Manuscript? manuscript;
  final bool collapsible;
  final ValueChanged<Manuscript>? onChanged;

  /// True while a cover request is on its way (an upload, say), so a host
  /// can hold what should not race it.
  final ValueChanged<bool>? onBusyChanged;

  @override
  ConsumerState<StudioCoverPicker> createState() => _StudioCoverPickerState();
}

class _StudioCoverPickerState extends ConsumerState<StudioCoverPicker> {
  Manuscript? _manuscript;
  Object? _loadError;
  late bool _expanded = !widget.collapsible;
  _CoverTask? _task;
  double? _uploadProgress;
  String? _error;
  String? _notice;
  Timer? _poll;

  /// Kept across a retry after a network failure, so a generation that did
  /// reach the server is replayed rather than charged twice.
  String? _generateRequestId;

  /// Set while an AI cover is on its way, to tell a drawing that landed from
  /// one the server gave up on.
  bool _awaitingAi = false;

  StudioRepository get _repository => ref.read(studioRepositoryProvider);

  ManuscriptCover? get _cover => _manuscript?.cover;

  @override
  void initState() {
    super.initState();
    final given = widget.manuscript;
    if (given != null) {
      _manuscript = given;
      _awaitingAi = given.cover.pending && given.cover.source.isAi;
      _syncPoll();
    } else {
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final manuscript = await _repository.getManuscript(widget.projectId);
      if (!mounted) return;
      setState(() {
        _manuscript = manuscript;
        _awaitingAi = manuscript.cover.pending && manuscript.cover.source.isAi;
      });
      _syncPoll();
    } catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  void _syncPoll() {
    final pending = _cover?.pending ?? false;
    if (!pending) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    _poll ??= Timer.periodic(studioCoverPollInterval, (_) => _refresh());
  }

  Future<void> _refresh() async {
    try {
      final manuscript = await _repository.getManuscript(widget.projectId);
      if (mounted) _apply(manuscript);
    } catch (_) {
      // The next tick tries again; a wait is not worth an error.
    }
  }

  /// Takes a new copy of the working copy and, when the cover moved, tells
  /// every other surface that shows it.
  void _apply(Manuscript next, {ProviderContainer? container}) {
    final before = _cover;
    final after = next.cover;
    final landed = before != null && before.pending && !after.pending;
    final moved =
        landed ||
        before == null ||
        before.source != after.source ||
        before.imageUrl != after.imageUrl;
    String? notice;
    if (landed && _awaitingAi && !after.source.isAi) {
      notice =
          'We couldn’t draw that cover, so your book keeps the cover it had.';
    }
    if (landed) {
      _awaitingAi = false;
      AppHaptics.success();
    }
    setState(() {
      _manuscript = next;
      if (notice != null) _notice = notice;
    });
    _syncPoll();
    widget.onChanged?.call(next);
    if (!moved) return;
    final scope =
        container ?? ProviderScope.containerOf(context, listen: false);
    scope
      ..invalidate(manuscriptProvider(widget.projectId))
      ..invalidate(projectDetailProvider(widget.projectId))
      ..invalidate(projectsProvider);
  }

  void _setTask(_CoverTask? task) {
    final wasBusy = _task != null;
    setState(() {
      _task = task;
      if (task != null) {
        _error = null;
        _notice = null;
      }
      if (task != _CoverTask.uploading) _uploadProgress = null;
    });
    if (wasBusy != (task != null)) widget.onBusyChanged?.call(task != null);
  }

  void _fail(String message) {
    if (!mounted) return;
    AppHaptics.error();
    _setTask(null);
    setState(() => _error = message);
  }

  // ---------------------------------------------------------------------------
  // The three choices

  Future<void> _chooseDesigned() async {
    final cover = _cover;
    if (cover == null || _task != null) return;
    if (cover.source == ManuscriptCoverSource.design) return;
    if (cover.source.isAi) {
      final confirmed = await showAppConfirmationDialog(
        context,
        title: 'Use a designed cover?',
        message:
            'Your AI cover will be replaced by one designed with your title '
            'and name. A new AI cover would cost credits again.',
        confirmLabel: 'Use designed cover',
        icon: Icons.auto_stories_outlined,
      );
      if (!confirmed || !mounted) return;
    }
    final container = ProviderScope.containerOf(context, listen: false);
    AppHaptics.selection();
    _setTask(_CoverTask.designing);
    try {
      final next = await _repository.useDesignedCover(widget.projectId);
      if (!mounted) return;
      _setTask(null);
      _apply(next, container: container);
    } catch (error) {
      _fail(userFacingError(error));
    }
  }

  Future<void> _chooseUpload() async {
    if (_cover == null || _task != null) return;
    final source = await _pickSource();
    if (source == null || !mounted) return;
    XFile? file;
    try {
      file = await ref
          .read(photoPickerProvider)
          .pickImage(source: source, purpose: PhotoPickerPurpose.bookImage);
    } catch (_) {
      _fail(
        source == ImageSource.camera
            ? 'Could not open the camera.'
            : 'Could not open your photos.',
      );
      return;
    }
    if (file == null || !mounted) return;
    final bytes = await file.readAsBytes();
    if (!mounted) return;
    final container = ProviderScope.containerOf(context, listen: false);
    _setTask(_CoverTask.uploading);
    setState(() => _uploadProgress = 0);
    try {
      final next = await _repository.uploadCover(
        projectId: widget.projectId,
        bytes: bytes,
        filename: studioCoverFilename(file),
        contentType: studioCoverContentType(file),
        onProgress: (sent, total) {
          if (mounted && total > 0) {
            setState(() => _uploadProgress = sent / total);
          }
        },
      );
      if (!mounted) return;
      _setTask(null);
      AppHaptics.success();
      _apply(next, container: container);
    } catch (error) {
      _fail(
        error is ApiException && error.code != 'NETWORK_ERROR'
            ? userFacingError(error)
            : 'The picture didn’t upload. Check your connection and try again.',
      );
    }
  }

  Future<ImageSource?> _pickSource() {
    return showAppActionSheet<ImageSource>(
      context,
      title: 'Your cover picture',
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Choose from photos'),
            onTap: () => Navigator.of(sheetContext).pop(ImageSource.gallery),
          ),
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take a photo'),
            onTap: () => Navigator.of(sheetContext).pop(ImageSource.camera),
          ),
        ],
      ),
    );
  }

  int? get _aiPrice {
    final billing = ref.read(billingProvider).value;
    return billing == null
        ? null
        : estimateStudioCoverCredits(billing.creditCosts);
  }

  Future<void> _chooseAi() async {
    final cover = _cover;
    if (cover == null || _task != null) return;
    if (cover.pending && cover.source.isAi) return;
    final price = _aiPrice;
    final again = cover.source.isAi;
    final confirmed = await showAppConfirmationDialog(
      context,
      title: again ? 'Draw a new cover?' : 'Generate a cover with AI?',
      message: again
          ? 'We’ll draw a different cover from your book. It replaces the one '
                'you have now.'
          : 'We’ll draw a cover from your book’s title and story. You can '
                'keep writing while it’s made.',
      confirmLabel: price == null
          ? 'Generate cover'
          : 'Generate cover · ${formatCredits(price)} credits',
      icon: Icons.auto_awesome_outlined,
    );
    if (!confirmed || !mounted) return;
    await _generate();
  }

  Future<void> _generate() async {
    final container = ProviderScope.containerOf(context, listen: false);
    _generateRequestId ??= studioRequestId('studio-cover');
    AppHaptics.commit();
    _setTask(_CoverTask.generating);
    try {
      final next = await _repository.generateCover(
        widget.projectId,
        requestId: _generateRequestId!,
      );
      _generateRequestId = null;
      container.invalidate(billingProvider);
      if (!mounted) return;
      _awaitingAi = next.cover.pending;
      _setTask(null);
      _apply(next, container: container);
    } on ApiException catch (error) {
      // The server answered and did nothing: the next tap is a new request.
      _generateRequestId = null;
      if (error.statusCode == 402) {
        _setTask(null);
        await _openPaywall(error);
        return;
      }
      _fail(userFacingError(error));
    } catch (error) {
      _fail(userFacingError(error));
    }
  }

  /// Not enough credits: the paywall, and — when a purchase closed the gap —
  /// the offer again, because a purchase made to do something has to be
  /// answered by the thing.
  Future<void> _openPaywall(ApiException error) async {
    final purchase = await showBillingPaywall(
      context,
      projectId: widget.projectId,
      title: null,
      creditsNeeded: PaywallCreditsNeeded.fromApiError(
        error,
        reason: 'Drawing a cover for your book.',
      ),
    );
    if (!mounted) return;
    ref.invalidate(billingProvider);
    if (purchase != null) await _chooseAi();
  }

  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final manuscript = _manuscript;
    if (manuscript == null) {
      return AppSwitcher(
        child: _loadError == null
            ? const _CoverSkeleton(key: ValueKey('cover-loading'))
            : AppInlineNotice(
                key: const ValueKey('cover-load-error'),
                tone: AppTone.error,
                title: 'Could not load your cover',
                message: userFacingError(_loadError!),
                actionLabel: 'Try again',
                onAction: _load,
              ),
      );
    }
    final cover = manuscript.cover;
    final working = _task != null;
    final preview = StudioCoverImage(
      projectId: widget.projectId,
      title: manuscript.title,
      authorName: manuscript.authorName,
      cover: cover,
      working: working && _task != _CoverTask.uploading,
      width: _expanded ? 96 : 48,
      radius: _expanded ? 10 : 6,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSize(
          duration: AppMotion.adapt(context, AppMotion.medium),
          curve: AppMotion.enter,
          alignment: Alignment.topCenter,
          child: _expanded
              ? _choices(context, cover, preview)
              : _summaryRow(context, cover, preview),
        ),
        AnimatedSize(
          duration: AppMotion.adapt(context, AppMotion.medium),
          curve: AppMotion.enter,
          alignment: Alignment.topCenter,
          child: AppSwitcher(child: _status(context, cover)),
        ),
      ],
    );
  }

  Widget _summaryRow(
    BuildContext context,
    ManuscriptCover cover,
    Widget preview,
  ) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      key: const ValueKey('cover-summary'),
      children: [
        preview,
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Cover',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                studioCoverSummary(cover),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                  height: 1.3,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: AppSpacing.xs),
        AppButton.text(
          key: const ValueKey('cover-change'),
          label: 'Change',
          onPressed: () {
            AppHaptics.selection();
            setState(() => _expanded = true);
          },
        ),
      ],
    );
  }

  Widget _choices(BuildContext context, ManuscriptCover cover, Widget preview) {
    // Watched only here: the price belongs to the choice, and a collapsed
    // picker has no business fetching the billing payload.
    final billing = ref.watch(billingProvider).value;
    final price = billing == null
        ? null
        : estimateStudioCoverCredits(billing.creditCosts);
    final idle = _task == null;
    return Row(
      key: const ValueKey('cover-choices'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        preview,
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Column(
            children: [
              _CoverChoice(
                key: const ValueKey('cover-choice-design'),
                icon: Icons.auto_stories_outlined,
                title: 'Designed',
                detail: 'Free',
                selected: cover.source == ManuscriptCoverSource.design,
                onTap: idle ? _chooseDesigned : null,
              ),
              const SizedBox(height: AppSpacing.xxs),
              _CoverChoice(
                key: const ValueKey('cover-choice-upload'),
                icon: Icons.add_photo_alternate_outlined,
                title: 'Your own picture',
                detail: 'Photo or artwork',
                selected: cover.source == ManuscriptCoverSource.upload,
                onTap: idle ? _chooseUpload : null,
              ),
              const SizedBox(height: AppSpacing.xxs),
              _CoverChoice(
                key: const ValueKey('cover-choice-ai'),
                icon: Icons.auto_awesome_outlined,
                title: 'Generate with AI',
                detail: price == null
                    ? 'Uses credits'
                    : '${formatCredits(price)} credits',
                selected: cover.source.isAi,
                onTap: idle && !(cover.pending && cover.source.isAi)
                    ? _chooseAi
                    : null,
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// What sits under the choices: the wait, the refusal, or what the chosen
  /// cover is.
  Widget _status(BuildContext context, ManuscriptCover cover) {
    final theme = Theme.of(context);
    final task = _task;
    if (task == _CoverTask.uploading) {
      return Padding(
        key: const ValueKey('cover-uploading'),
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: Semantics(
          liveRegion: true,
          label: 'Uploading your cover picture',
          child: ExcludeSemantics(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Uploading your picture…',
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: AppSpacing.xs),
                PlanBuildProgressBar(value: _uploadProgress),
              ],
            ),
          ),
        ),
      );
    }
    final generating =
        task == _CoverTask.generating || (cover.pending && cover.source.isAi);
    if (generating) {
      return Padding(
        key: const ValueKey('cover-drawing'),
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: StudioWorkingProgress(
          semanticLabel: 'Drawing your cover',
          tau: const Duration(seconds: 30),
          stageInterval: const Duration(seconds: 5),
          stages: const [
            'Reading your book…',
            'Sketching your cover…',
            'Painting the details…',
            'Adding the finishing touches…',
          ],
        ),
      );
    }
    if (task == _CoverTask.designing || cover.pending) {
      return Padding(
        key: const ValueKey('cover-designing'),
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: StudioWorkingProgress(
          semanticLabel: 'Making your cover',
          tau: const Duration(seconds: 8),
          stages: const ['Setting your title…', 'Designing your cover…'],
        ),
      );
    }
    final error = _error;
    if (error != null) {
      return Padding(
        key: ValueKey('cover-error-$error'),
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: AppInlineNotice(
          tone: AppTone.error,
          title: 'Could not change your cover',
          message: error,
          onDismiss: () => setState(() => _error = null),
        ),
      );
    }
    final notice = _notice;
    if (notice != null) {
      return Padding(
        key: const ValueKey('cover-notice'),
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: AppInlineNotice(
          title: 'Your cover didn’t change',
          message: notice,
          onDismiss: () => setState(() => _notice = null),
        ),
      );
    }
    if (!_expanded) return const SizedBox(width: double.infinity);
    return Container(
      key: ValueKey('cover-about-${cover.source.name}'),
      width: double.infinity,
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Text(
        studioCoverDescription(cover),
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          height: 1.35,
        ),
      ),
    );
  }
}

extension on ManuscriptCoverSource {
  bool get isAi => this == ManuscriptCoverSource.ai;
}

/// A picker can hand back bytes with no name (a camera capture on some
/// platforms); the server only reads the extension.
String studioCoverFilename(XFile file) {
  if (file.name.trim().isNotEmpty) return file.name;
  return switch (studioCoverContentType(file)) {
    'image/png' => 'cover.png',
    'image/webp' => 'cover.webp',
    'image/heic' => 'cover.heic',
    _ => 'cover.jpg',
  };
}

String studioCoverContentType(XFile file) {
  final mime = file.mimeType;
  if (mime != null && mime.startsWith('image/')) return mime;
  final name = file.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.heic') || name.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}

/// One way to have a cover: a row that reads as a choice, the chosen one
/// tinted in the brand's container colour rather than the button fill.
class _CoverChoice extends StatelessWidget {
  const _CoverChoice({
    required this.icon,
    required this.title,
    required this.detail,
    required this.selected,
    required this.onTap,
    super.key,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final enabled = onTap != null;
    final foreground = selected ? colors.onPrimaryContainer : colors.onSurface;
    final support = selected
        ? colors.onPrimaryContainer.withValues(alpha: 0.8)
        : colors.onSurfaceVariant;
    final radius = BorderRadius.circular(AppRadii.control);
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      inMutuallyExclusiveGroup: true,
      label: '$title. $detail',
      onTap: onTap,
      child: ExcludeSemantics(
        child: AnimatedOpacity(
          duration: AppMotion.adapt(context, AppMotion.fast),
          opacity: enabled || selected ? 1 : 0.55,
          child: Material(
            color: selected
                ? colors.primaryContainer.withValues(alpha: 0.75)
                : Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: radius,
              side: BorderSide(
                color: selected
                    ? colors.primary.withValues(alpha: 0.35)
                    : colors.outlineVariant,
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget,
                ),
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(
                    AppSpacing.sm,
                    6,
                    AppSpacing.xs,
                    6,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        icon,
                        size: 20,
                        color: selected ? foreground : colors.primary,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: foreground,
                              ),
                            ),
                            Text(
                              detail,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: support,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: AppSpacing.xxs),
                      Icon(
                        selected
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked,
                        size: 20,
                        color: selected ? foreground : colors.outline,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CoverSkeleton extends StatelessWidget {
  const _CoverSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return const AppSkeletonGroup(
      label: 'Loading your cover',
      child: Row(
        children: [
          AppSkeleton.box(width: 48, height: 72, radius: 6),
          SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppSkeleton.line(widthFactor: 0.3, height: 14),
                SizedBox(height: 6),
                AppSkeleton.line(widthFactor: 0.7),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
