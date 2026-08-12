import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/character_image_share.dart';
import '../data/characters_repository.dart';
import '../domain/character_image_models.dart';
import '../domain/character_models.dart';
import 'character_editor_sheet.dart';
import 'character_image_actions.dart';
import 'character_image_strip.dart';
import 'character_image_viewer.dart';
import 'character_photo_pick.dart';
import 'character_portrait_polling.dart';
import 'character_profile_details.dart';
import 'character_profile_header.dart';
import 'character_reference_card.dart';

/// Pushes one character's profile.
///
/// A plain route rather than a `GoRoute`: the library screen is already pushed
/// imperatively from three places, and nothing needs a deep link into a
/// character yet. The screen takes an id, so adding `/characters/:id` later
/// changes nothing else here.
Route<void> characterProfileRoute(String characterId) {
  return PageRouteBuilder<void>(
    transitionDuration: AppMotion.medium,
    reverseTransitionDuration: AppMotion.fast,
    pageBuilder: (_, _, _) => CharacterProfileScreen(characterId: characterId),
    transitionsBuilder: (context, animation, _, child) {
      if (AppMotion.reducedMotion(context)) {
        return FadeTransition(opacity: animation, child: child);
      }
      return FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.02),
            end: Offset.zero,
          ).animate(CurvedAnimation(parent: animation, curve: AppMotion.enter)),
          child: child,
        ),
      );
    },
  );
}

/// One character's page: their picture at a size worth looking at, what a book
/// will do with it, who they are, and every picture they have ever had.
class CharacterProfileScreen extends ConsumerStatefulWidget {
  const CharacterProfileScreen({required this.characterId, super.key});

  final String characterId;

  @override
  ConsumerState<CharacterProfileScreen> createState() =>
      _CharacterProfileScreenState();
}

class _CharacterProfileScreenState
    extends ConsumerState<CharacterProfileScreen>
    with CharacterPortraitPolling {
  bool _saving = false;
  bool _portraitBusy = false;
  bool _pictureBusy = false;

  /// The frame the reader just approved, drawn before the round trip finishes.
  Uint8List? _pendingUpload;
  double? _uploadProgress;

  /// Minted once per gesture and reused if the reader taps again after a
  /// timeout, so a retry cannot buy a second drawing.
  String? _portraitRequestId;

  bool get _busy => _saving || _portraitBusy || _pictureBusy;

  /// Read in `build` and cached, because the polling mixin also asks for it
  /// from its lifecycle handler. Watching a provider from there does work —
  /// Riverpod only refuses a disposed element — but it registers a dependency
  /// outside the build that owns it, which is a subtlety this screen does not
  /// need to carry. `CharacterLibraryScreen` caches the same way.
  bool _drawing = false;

  LibraryCharacter? get _character {
    final library = ref.watch(charactersProvider).value;
    if (library == null) return null;
    for (final character in library.characters) {
      if (character.id == widget.characterId) return character;
    }
    return null;
  }

  @override
  bool get isDrawing => _drawing;

  @override
  void onPollTick() {
    // A finished drawing is a new entry in the strip, not just a status flip.
    ref.invalidate(characterImagesProvider(widget.characterId));
  }

  void _refreshAll() {
    ref.invalidate(charactersProvider);
    ref.invalidate(characterImagesProvider(widget.characterId));
  }

  Future<void> _addPicture() async {
    if (_busy) return;
    final action = await showCharacterPhotoActions(context);
    if (action == null || !mounted) return;
    final cropped = await pickAndCropCharacterPhoto(context, action: action);
    if (cropped == null || !mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _pendingUpload = cropped;
      _uploadProgress = 0;
      _pictureBusy = true;
    });
    try {
      await ref
          .read(charactersRepositoryProvider)
          .uploadPhoto(
            id: widget.characterId,
            filename: 'photo.jpg',
            bytes: cropped,
            mimeType: 'image/jpeg',
            onProgress: (sent, total) {
              if (!mounted || total <= 0) return;
              setState(() => _uploadProgress = sent / total);
            },
          );
      if (!mounted) return;
      _refreshAll();
      setState(() {
        _pendingUpload = null;
        _uploadProgress = null;
        _pictureBusy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _pendingUpload = null;
        _uploadProgress = null;
        _pictureBusy = false;
      });
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _generatePortrait(LibraryCharacter character) async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.of(context);
    // Reused across retries: the API treats a repeated requestId as the same
    // attempt, so a tap after a timeout cannot charge twice.
    final requestId =
        _portraitRequestId ??= 'portrait-${DateTime.now().microsecondsSinceEpoch}';
    AppHaptics.commit();
    setState(() => _portraitBusy = true);
    try {
      final started = await ref
          .read(charactersRepositoryProvider)
          .generatePortrait(id: character.id, requestId: requestId);
      if (!mounted) return;
      _refreshAll();
      setState(() {
        _portraitBusy = false;
        _portraitRequestId = null;
      });
      messenger.showAppSnackBar(
        SnackBar(
          content: Text(
            started.creditsCharged > 0
                ? 'Portrait queued — ${started.creditsCharged} credits. A failed drawing is refunded.'
                : 'Portrait queued.',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _portraitBusy = false);
      if (error is ApiException && error.statusCode == 402) {
        await showBillingPaywall(
          context,
          title: null,
          creditsNeeded: PaywallCreditsNeeded.fromApiError(
            error,
            reason: 'Drawing a portrait of ${character.name}.',
          ),
        );
        if (!mounted) return;
        ref.invalidate(billingProvider);
        return;
      }
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _promote(CharacterImage image, {required String name}) async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.of(context);
    AppHaptics.success();
    setState(() => _pictureBusy = true);
    try {
      await ref
          .read(charactersRepositoryProvider)
          .promoteImage(id: widget.characterId, imageId: image.id);
      if (!mounted) return;
      _refreshAll();
      setState(() => _pictureBusy = false);
      messenger.showAppSnackBar(
        SnackBar(
          content: Text(
            image.canBeMain
                ? 'Main picture changed. New books will draw $name from it.'
                : 'Picture changed.',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => _pictureBusy = false);
      _refreshAll();
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _deleteImage(
    LibraryCharacter character,
    CharacterImage image,
    List<CharacterImage> images,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final consequence = characterImageDeleteConsequence(
      character: character,
      image: image,
      hasPromotableSuccessor: _successorFor(image, images) != null,
    );
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete this picture?',
      message: consequence,
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => _pictureBusy = true);
    try {
      await ref
          .read(charactersRepositoryProvider)
          .deleteImage(id: widget.characterId, imageId: image.id);
      if (!mounted) return;
      _refreshAll();
      setState(() => _pictureBusy = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _pictureBusy = false);
      _refreshAll();
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  /// The picture that would take over if [image] were deleted — the same rule
  /// the server applies, so the confirmation copy cannot promise something the
  /// delete will not do.
  CharacterImage? _successorFor(
    CharacterImage image,
    List<CharacterImage> images,
  ) {
    if (!image.isCurrentReference) return null;
    for (final candidate in images) {
      if (candidate.id == image.id) continue;
      if (candidate.canBeMain || candidate.isCurrentReference) return candidate;
    }
    return null;
  }

  Future<void> _share(CharacterImage image) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await shareCharacterImage(
        apiClient: ref.read(apiClientProvider),
        url: image.url,
        imageId: image.id,
      );
    } catch (error) {
      if (!mounted) return;
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _openOptions(
    LibraryCharacter character,
    CharacterImage image,
    List<CharacterImage> images, {
    bool includeView = true,
  }) async {
    final library = ref.read(charactersProvider).value;
    final action = await showCharacterImageActions(
      context,
      character: character,
      image: image,
      portraitCredits: library?.portraitCredits ?? 0,
      hasPromotableSuccessor: _successorFor(image, images) != null,
      includeView: includeView,
    );
    if (action == null || !mounted) return;
    switch (action) {
      case CharacterImageAction.view:
        await _openViewer(character, images, images.indexOf(image));
      case CharacterImageAction.makeMain:
      case CharacterImageAction.showAsPhoto:
        await _promote(image, name: character.name);
      case CharacterImageAction.draw:
        await _generatePortrait(character);
      case CharacterImageAction.share:
        await _share(image);
      case CharacterImageAction.delete:
        await _deleteImage(character, image, images);
    }
  }

  Future<void> _openViewer(
    LibraryCharacter character,
    List<CharacterImage> images,
    int index,
  ) async {
    if (images.isEmpty) return;
    final result = await showCharacterImageViewer(
      context: context,
      images: images,
      initialIndex: index.clamp(0, images.length - 1),
      characterName: character.name,
    );
    if (result == null || !mounted) return;
    // The list can have moved while the viewer was open; act on the id, never
    // on the index the viewer was showing.
    CharacterImage? target;
    for (final image in images) {
      if (image.id == result.imageId) target = image;
    }
    if (target == null) return;
    switch (result.intent) {
      case CharacterViewerIntent.makeMain:
      case CharacterViewerIntent.showAsPhoto:
        await _promote(target, name: character.name);
      case CharacterViewerIntent.options:
        await _openOptions(character, target, images, includeView: false);
    }
  }

  Future<void> _editDetails(LibraryCharacter character) async {
    await showCharacterEditorSheet(context, character: character);
    if (!mounted) return;
    ref.invalidate(charactersProvider);
  }

  Future<void> _applySuggestion(
    LibraryCharacter character,
    String? suggestion,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      await ref
          .read(charactersRepositoryProvider)
          .update(
            id: character.id,
            description: suggestion,
            dismissSuggestion: suggestion == null ? true : null,
          );
      if (!mounted) return;
      ref.invalidate(charactersProvider);
      setState(() => _saving = false);
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  Future<void> _deleteCharacter(LibraryCharacter character) async {
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete ${character.name}?',
      message:
          'Books already made with ${character.name} keep their pages — this '
          'only removes the character from your library.',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      await ref.read(charactersRepositoryProvider).delete(character.id);
      if (!mounted) return;
      ref.invalidate(charactersProvider);
      navigator.pop();
    } catch (error) {
      messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final libraryValue = ref.watch(charactersProvider);
    final character = _character;
    _drawing = character?.portraitStatus.isBusy ?? false;
    syncPortraitPolling();

    if (character == null) {
      return Scaffold(
        appBar: AppBar(),
        body: libraryValue.when(
          loading: () => const AppLoadingState(message: 'Loading this character'),
          error: (error, stackTrace) => AppErrorState(
            title: 'Could not load this character',
            message: userFacingError(error),
            onRetry: () => ref.invalidate(charactersProvider),
          ),
          // The library loaded and this character is not in it — deleted from
          // somewhere else, or gone with the account.
          data: (_) => const AppEmptyState(
            icon: Icons.person_off_outlined,
            title: 'This character is gone',
            message: 'It is no longer in your library.',
          ),
        ),
      );
    }

    final imagesValue = ref.watch(characterImagesProvider(widget.characterId));
    final images = imagesValue.value ?? const <CharacterImage>[];
    CharacterImage? mainImage;
    for (final image in images) {
      if (image.isMain) mainImage = image;
    }

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async {
          _refreshAll();
          await ref.read(charactersProvider.future);
        },
        child: CustomScrollView(
          slivers: [
            SliverAppBar(
              pinned: true,
              expandedHeight: math.min(
                MediaQuery.sizeOf(context).width,
                420,
              ),
              // A bare title overflows at a 1.6 text scale; the picture behind
              // it is already the identity, so one clipped line is enough.
              title: Text(
                character.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              actions: [
                PopupMenuButton<String>(
                  key: const ValueKey('character-profile-menu'),
                  tooltip: 'Character actions',
                  onSelected: (value) {
                    switch (value) {
                      case 'add':
                        _addPicture();
                      case 'delete':
                        _deleteCharacter(character);
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(value: 'add', child: Text('Add a picture')),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text('Delete character'),
                    ),
                  ],
                ),
              ],
              flexibleSpace: FlexibleSpaceBar(
                collapseMode: CollapseMode.parallax,
                background: CharacterProfileHeader(
                  character: character,
                  mainImage: mainImage,
                  fallbackImageUrl: character.displayImageUrl,
                  pendingUpload: _pendingUpload,
                  uploadProgress: _uploadProgress,
                  onTapPicture: () => _openViewer(
                    character,
                    images,
                    mainImage == null ? 0 : images.indexOf(mainImage),
                  ),
                  onAddPicture: _addPicture,
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(18, AppSpacing.md, 18, 0),
              sliver: SliverToBoxAdapter(
                child: CharacterReferenceCard(
                  character: character,
                  images: images,
                  portraitCredits: libraryValue.value?.portraitCredits ?? 0,
                  busy: _busy,
                  portraitBusy: _portraitBusy,
                  waitGaveUp: portraitWaitGaveUp,
                  onGeneratePortrait: () => _generatePortrait(character),
                  onAddPicture: _addPicture,
                  onPromote: (image) => _promote(image, name: character.name),
                  onCheckAgain: resumePortraitPolling,
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(18, AppSpacing.lg, 18, 0),
              sliver: SliverToBoxAdapter(
                child: CharacterProfileDetails(
                  character: character,
                  busy: _busy,
                  onEdit: () => _editDetails(character),
                  onUseSuggestion: (suggestion) =>
                      _applySuggestion(character, suggestion),
                  onDismissSuggestion: () => _applySuggestion(character, null),
                ),
              ),
            ),
            if (imagesValue.hasError && images.isEmpty)
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(18, AppSpacing.lg, 18, 32),
                sliver: SliverToBoxAdapter(
                  // Not folded into the strip's empty state: "no pictures yet"
                  // and "we could not read your pictures" ask the reader for
                  // opposite things, and the second one is not their fault.
                  child: AppInlineNotice(
                    icon: Icons.wifi_off_outlined,
                    tone: AppTone.error,
                    title: 'Could not load their pictures',
                    message: userFacingError(imagesValue.error!),
                    actionLabel: 'Try again',
                    onAction: () => ref.invalidate(
                      characterImagesProvider(widget.characterId),
                    ),
                  ),
                ),
              )
            else
            SliverPadding(
              padding: const EdgeInsets.only(top: AppSpacing.lg, bottom: 32),
              sliver: SliverToBoxAdapter(
                child: CharacterImageStrip(
                  images: images,
                  loading: imagesValue.isLoading,
                  pendingUpload: _pendingUpload,
                  uploadProgress: _uploadProgress,
                  drawingInProgress: character.portraitStatus.isBusy,
                  onOpen: (index) => _openViewer(character, images, index),
                  onOptions: (image) =>
                      _openOptions(character, image, images),
                  onAdd: _addPicture,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
