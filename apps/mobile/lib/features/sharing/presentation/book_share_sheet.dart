import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/book_share_repository.dart';
import '../domain/book_share_models.dart';
import 'book_share_form.dart';
import 'book_share_live.dart';
import 'book_share_progress.dart';

/// What the author is told when a save shared the book but held its note.
const bookShareNoteHeldNotice =
    'Your book is shared; your note is waiting for review.';

/// Why a paywall opened from here: the unlock a full share takes.
const _unlockPaywallReason =
    'Sharing the whole book uses its export unlock. Credits unlock protected '
    'downloads for this book.';

/// Opens the book's share sheet: its public link if it has one, the settings
/// to make one if not.
Future<void> showBookShareSheet(
  BuildContext context, {
  required String projectId,
  String? bookTitle,
}) {
  return showAppBottomSheet<void>(
    context,
    builder: (_) => BookShareSheet(projectId: projectId, bookTitle: bookTitle),
  );
}

/// One book's sharing, in whatever shape it is in now.
///
/// The sheet is the only place a share is made, changed or stopped, and it
/// follows the share rather than a flow: a live link shows what readers get
/// and the things to do with it; Edit turns the same sheet into the settings;
/// a save turns it back. A link an operator took down, and a book that is not
/// ready, say so instead of offering controls that would be refused.
class BookShareSheet extends ConsumerStatefulWidget {
  const BookShareSheet({required this.projectId, this.bookTitle, super.key});

  final String projectId;

  /// Offered to the system share sheet as the message subject.
  final String? bookTitle;

  @override
  ConsumerState<BookShareSheet> createState() => _BookShareSheetState();
}

class _BookShareSheetState extends ConsumerState<BookShareSheet> {
  /// The settings are open over a live share.
  bool _editing = false;
  BookShareSaving? _saving;
  bool _stopping = false;
  String? _captionError;
  BookShareRefusal? _refusal;

  /// The server asked for a confirmation the form had not shown, because the
  /// share was live when the sheet opened.
  bool _askRights = false;
  bool _askLikeness = false;
  String? _savedNotice;
  String? _stoppedNotice;
  String? _stopError;

  BookShareController get _controller =>
      ref.read(bookShareProvider(widget.projectId).notifier);

  void _close() => Navigator.of(context).maybePop();

  void _reload() => ref.invalidate(bookShareProvider(widget.projectId));

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(bookShareProvider(widget.projectId));
    // `value`, not `asData`: a re-read keeps the sheet on what it has.
    final snapshot = value.value;
    final Widget view;
    if (snapshot != null) {
      view = _viewFor(snapshot);
    } else if (value.hasError && !value.isLoading) {
      view = AppSheetScaffold(
        key: const ValueKey('book-share-error'),
        title: bookShareSheetTitle,
        icon: Icons.link_rounded,
        onClose: _close,
        children: [
          AppErrorState(
            compact: true,
            title: 'Couldn’t load sharing',
            message: userFacingError(value.error!),
            onRetry: _reload,
          ),
        ],
      );
    } else {
      view = AppSheetScaffold(
        key: const ValueKey('book-share-loading'),
        title: bookShareSheetTitle,
        icon: Icons.link_rounded,
        onClose: _close,
        children: const [_BookShareSkeleton()],
      );
    }
    return AppSwitcher(child: view);
  }

  Widget _viewFor(BookShareSnapshot snapshot) {
    final share = snapshot.share;
    if (share != null && share.isTakenDown) {
      return BookShareTakenDownView(
        key: const ValueKey('book-share-taken-down-view'),
        share: share,
        onClose: _close,
      );
    }
    final live = snapshot.activeShare;
    if (live != null && !_editing) {
      return BookShareLiveView(
        key: const ValueKey('book-share-live'),
        share: live,
        book: snapshot.book,
        notice: _savedNotice,
        error: _stopError,
        stopping: _stopping,
        onShareLink: () => _sendLink(live),
        onEdit: _startEditing,
        onStop: _stop,
        onClose: _close,
      );
    }
    if (live == null && !snapshot.book.shareable) {
      return BookShareUnavailableView(
        key: const ValueKey('book-share-unavailable'),
        reason: snapshot.book.unavailableReason,
        onRetry: _reload,
        onClose: _close,
      );
    }
    return BookShareForm(
      key: ValueKey('book-share-form-${live != null}'),
      book: snapshot.book,
      previous: share,
      editing: live != null,
      saving: _saving,
      captionError: _captionError,
      refusal: _refusal,
      notice: _stoppedNotice,
      askRights: _askRights,
      askLikeness: _askLikeness,
      onSubmit: (request) => _save(snapshot, request),
      onGetCredits: () => _openPaywall(
        PaywallCreditsNeeded(
          credits: snapshot.book.exportUnlockCredits,
          reason: _unlockPaywallReason,
        ),
      ),
      onCancel: live == null ? null : _cancelEditing,
      onCaptionEdited: () => setState(() => _captionError = null),
      onClose: _close,
    );
  }

  void _startEditing() {
    setState(() {
      _editing = true;
      _savedNotice = null;
      _stopError = null;
      _refusal = null;
      _captionError = null;
      _askRights = false;
      _askLikeness = false;
    });
  }

  void _cancelEditing() {
    setState(() {
      _editing = false;
      _refusal = null;
      _captionError = null;
    });
  }

  Future<void> _save(BookShareSnapshot snapshot, BookShareRequest draft) async {
    if (_saving != null) return;
    final book = snapshot.book;
    final live = snapshot.activeShare;
    var request = draft;
    if (draft.mode == BookShareMode.full && !book.exportUnlocked) {
      // The download spends a covered unlock silently because tapping a file
      // is the ask. Sharing is not, so the price is agreed to in so many words.
      final agreed = await showAppConfirmationDialog(
        context,
        title: 'Unlock this book?',
        message:
            'Sharing the whole book uses its export unlock: '
            '${book.exportUnlockCredits} credits, the same unlock the PDF '
            'download takes. Its downloads are included afterwards. Previews '
            'are free.',
        confirmLabel: live == null ? 'Unlock and share' : 'Unlock and save',
        cancelLabel: 'Not now',
        icon: Icons.lock_open_outlined,
      );
      if (!agreed || !mounted) return;
      request = draft.withUnlockAccepted();
    }
    final note = request.caption?.trim() ?? '';
    final checkingNote = note.isNotEmpty && note != (snapshot.share?.caption);
    setState(() {
      _saving = BookShareSaving(
        stages: bookShareSavingStages(
          creating: live == null,
          checkingBook: live == null || live.mode != request.mode,
          checkingNote: checkingNote,
        ),
        slow: checkingNote,
      );
      _captionError = null;
      _refusal = null;
      _savedNotice = null;
      _stoppedNotice = null;
      _stopError = null;
    });
    try {
      final saved = await _controller.save(request);
      if (!mounted) return;
      final shared = saved.snapshot.activeShare;
      setState(() {
        _saving = null;
        _editing = false;
        _askRights = false;
        _askLikeness = false;
        _savedNotice =
            note.isNotEmpty &&
                shared?.captionStatus == BookShareCaptionStatus.pendingReview
            ? bookShareNoteHeldNotice
            : null;
      });
      AppHaptics.success();
      // A new link goes straight to the system share sheet: sending it is
      // what the author came to do.
      if (live == null && shared != null) await _sendLink(shared);
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = null);
      await _showSaveError(error, editing: live != null);
    }
  }

  /// Puts the server's refusal beside what it is about: a note's sentence
  /// under the note, a missing confirmation as that checkbox, a short balance
  /// as the paywall, anything else above the button.
  Future<void> _showSaveError(Object error, {required bool editing}) async {
    AppHaptics.error();
    final title = editing ? 'Changes not saved' : 'Not shared yet';
    if (error is! ApiException) {
      setState(
        () => _refusal = BookShareRefusal(
          title: title,
          message: userFacingError(error),
        ),
      );
      return;
    }
    final code = error.code;
    if (code.startsWith('CAPTION_')) {
      setState(() => _captionError = error.message);
      return;
    }
    switch (code) {
      case 'INSUFFICIENT_CREDITS':
        await _openPaywall(
          PaywallCreditsNeeded.fromApiError(
            error,
            reason: _unlockPaywallReason,
          ),
        );
      case 'CONTENT_RESTRICTED' || 'COPYRIGHT_RESTRICTED':
        setState(
          () => _refusal = BookShareRefusal(
            title: 'This book can’t be shared publicly',
            message: error.message,
          ),
        );
      case 'SHARE_RIGHTS_REQUIRED' || 'SHARE_LIKENESS_REQUIRED':
        setState(() {
          _askRights = _askRights || code == 'SHARE_RIGHTS_REQUIRED';
          _askLikeness = _askLikeness || code == 'SHARE_LIKENESS_REQUIRED';
          _refusal = BookShareRefusal(title: title, message: error.message);
        });
      case 'EXPORT_UNLOCK_REQUIRED' ||
          'SHARE_TAKEN_DOWN' ||
          'SHARE_NOT_AVAILABLE' ||
          'SHARE_BEING_UPDATED' ||
          'PREVIEW_TOO_LONG' ||
          'PREVIEW_PAGES_REQUIRED':
        // The book changed under the sheet — its unlock, its length, its
        // status. Read it again so the controls match what the server knows.
        setState(
          () =>
              _refusal = BookShareRefusal(title: title, message: error.message),
        );
        _reload();
      default:
        setState(
          () =>
              _refusal = BookShareRefusal(title: title, message: error.message),
        );
    }
  }

  Future<void> _openPaywall(PaywallCreditsNeeded needed) async {
    await showBillingPaywall(
      context,
      projectId: widget.projectId,
      title: null,
      creditsNeeded: needed,
    );
    if (!mounted) return;
    ref.invalidate(billingProvider);
  }

  Future<void> _sendLink(BookShare share) async {
    try {
      await ref.read(shareLinkSenderProvider)(
        share.url,
        subject: widget.bookTitle,
      );
    } catch (_) {
      // Nothing to report: the link is on screen with Copy beside it.
    }
  }

  Future<void> _stop() async {
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Stop sharing this book?',
      message:
          'The link stops working for everyone who has it. You can share the '
          'book again later with a new link.',
      confirmLabel: 'Stop sharing',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _stopping = true;
      _stopError = null;
    });
    try {
      await _controller.stop();
      if (!mounted) return;
      setState(() {
        _stopping = false;
        _savedNotice = null;
        _stoppedNotice = 'Sharing stopped. The link no longer works.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _stopping = false;
        _stopError = userFacingError(error);
      });
    }
  }
}

/// The settings' shape while the first read is on its way.
class _BookShareSkeleton extends StatelessWidget {
  const _BookShareSkeleton();

  @override
  Widget build(BuildContext context) {
    return const AppSkeletonGroup(
      label: 'Loading sharing',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppSkeleton.box(height: 48, radius: AppRadii.control),
          SizedBox(height: AppSpacing.md),
          AppSkeleton.line(widthFactor: 0.8),
          SizedBox(height: AppSpacing.xs),
          AppSkeleton.line(widthFactor: 0.5),
          SizedBox(height: AppSpacing.lg),
          AppSkeleton.box(height: 96, radius: AppRadii.control),
          SizedBox(height: AppSpacing.md),
          AppSkeleton.box(height: 72, radius: AppRadii.card),
        ],
      ),
    );
  }
}
