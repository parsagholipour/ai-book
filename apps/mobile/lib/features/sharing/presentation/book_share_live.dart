import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/book_share_models.dart';

// The share sheet's settled states: a live link and what it shows, a link an
// operator took down, and a book that cannot be shared yet. The form that
// makes or changes a share is `book_share_form.dart`.

const bookShareSheetTitle = 'Share your book';

/// A share that is live: what readers get, how the note is doing, and the
/// things to do with a link — send it, copy it, change it, stop it.
class BookShareLiveView extends StatefulWidget {
  const BookShareLiveView({
    required this.share,
    required this.book,
    required this.onShareLink,
    required this.onEdit,
    required this.onStop,
    required this.onClose,
    this.stopping = false,
    this.notice,
    this.error,
    super.key,
  });

  final BookShare share;
  final BookShareBook book;
  final VoidCallback onShareLink;
  final VoidCallback onEdit;
  final VoidCallback onStop;
  final VoidCallback onClose;
  final bool stopping;

  /// A line about the save that just landed, e.g. that the note is held.
  final String? notice;

  /// Why the last stop failed.
  final String? error;

  @override
  State<BookShareLiveView> createState() => _BookShareLiveViewState();
}

class _BookShareLiveViewState extends State<BookShareLiveView> {
  bool _copied = false;
  Timer? _copiedTimer;

  @override
  void dispose() {
    _copiedTimer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.share.url));
    if (!mounted) return;
    AppHaptics.selection();
    // The button answers for itself: a snack bar would open under this sheet.
    setState(() => _copied = true);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final share = widget.share;
    final notice = widget.notice;
    final error = widget.error;
    return AppSheetScaffold(
      title: bookShareSheetTitle,
      icon: Icons.link_rounded,
      onClose: widget.onClose,
      footer: _footer(),
      children: [
        if (notice != null) ...[
          AppInlineNotice(
            key: const ValueKey('book-share-notice'),
            tone: AppTone.info,
            icon: Icons.hourglass_top_rounded,
            title: notice,
            message:
                'The link works now. Your note appears beside the book once '
                'it has been approved.',
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.public, color: colors.primary),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    bookShareSummary(share, widget.book),
                    key: const ValueKey('book-share-summary'),
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  SelectableText(
                    share.url,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    [
                      bookShareViewCount(share.viewCount),
                      share.showAuthorName
                          ? 'shown with your name'
                          : 'shown without your name',
                    ].join(' · '),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        if (share.caption != null) ...[
          const SizedBox(height: AppSpacing.md),
          _SharedNote(caption: share.caption!, status: share.captionStatus),
        ],
        if (!widget.book.shareable) ...[
          const SizedBox(height: AppSpacing.md),
          const AppInlineNotice(
            title: 'Your book is being updated',
            message:
                'The link keeps working. You can change how it is shared once '
                'the update is in.',
          ),
        ],
        if (error != null) ...[
          const SizedBox(height: AppSpacing.md),
          AppInlineNotice(
            tone: AppTone.error,
            title: 'Sharing did not stop',
            message: error,
          ),
        ],
      ],
    );
  }

  Widget _footer() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppButton.primary(
          label: 'Share link',
          leading: const Icon(Icons.ios_share_outlined),
          expanded: true,
          onPressed: widget.stopping ? null : widget.onShareLink,
        ),
        const SizedBox(height: AppSpacing.xs),
        Row(
          children: [
            Expanded(
              child: AppButton.outlined(
                label: _copied ? 'Copied' : 'Copy link',
                leading: Icon(_copied ? Icons.check : Icons.copy_outlined),
                onPressed: widget.stopping ? null : _copy,
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: AppButton.outlined(
                label: 'Edit',
                leading: const Icon(Icons.tune),
                onPressed: widget.stopping || !widget.book.shareable
                    ? null
                    : widget.onEdit,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.xxs),
        AppButton.text(
          label: 'Stop sharing',
          loading: widget.stopping,
          loadingLabel: 'Stopping',
          onPressed: widget.onStop,
        ),
      ],
    );
  }
}

/// The note beside the book, and what happened to it when it was not simply
/// allowed.
class _SharedNote extends StatelessWidget {
  const _SharedNote({required this.caption, required this.status});

  final String caption;
  final BookShareCaptionStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final badge = switch (status) {
      BookShareCaptionStatus.pendingReview => const AppStatusBadge(
        label: 'Note under review',
        icon: Icons.hourglass_top_rounded,
        tone: AppTone.info,
      ),
      BookShareCaptionStatus.removed => const AppStatusBadge(
        label: 'Note removed by a moderator',
        icon: Icons.block,
        tone: AppTone.error,
      ),
      BookShareCaptionStatus.allowed || BookShareCaptionStatus.none => null,
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Your note',
              style: theme.textTheme.labelLarge?.copyWith(
                color: colors.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.xxs),
            Text(
              caption,
              style: theme.textTheme.bodyMedium?.copyWith(
                decoration: status == BookShareCaptionStatus.removed
                    ? TextDecoration.lineThrough
                    : null,
              ),
            ),
            if (badge != null) ...[
              const SizedBox(height: AppSpacing.xs),
              badge,
            ],
          ],
        ),
      ),
    );
  }
}

/// A share an operator removed. It cannot be shared again, so there is
/// nothing to offer beyond saying so and why.
class BookShareTakenDownView extends StatelessWidget {
  const BookShareTakenDownView({
    required this.share,
    required this.onClose,
    super.key,
  });

  final BookShare share;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final reason = share.takedownReason?.trim();
    return AppSheetScaffold(
      title: bookShareSheetTitle,
      icon: Icons.link_off_outlined,
      onClose: onClose,
      children: [
        AppInlineNotice(
          key: const ValueKey('book-share-taken-down'),
          tone: AppTone.error,
          icon: Icons.block,
          title: reason == null || reason.isEmpty
              ? 'Taken down'
              : 'Taken down: $reason',
          message:
              'A moderator removed this book’s public link. The link no '
              'longer works, and this book can’t be shared again.',
        ),
      ],
    );
  }
}

/// A book with no share that cannot be shared yet: not finished, or its PDF
/// is being rebuilt after an edit.
class BookShareUnavailableView extends StatelessWidget {
  const BookShareUnavailableView({
    required this.reason,
    required this.onRetry,
    required this.onClose,
    super.key,
  });

  final BookShareUnavailableReason? reason;
  final VoidCallback onRetry;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final updating = reason == BookShareUnavailableReason.beingUpdated;
    return AppSheetScaffold(
      title: bookShareSheetTitle,
      icon: Icons.link_rounded,
      onClose: onClose,
      children: [
        AppEmptyState(
          compact: true,
          icon: updating ? Icons.autorenew : Icons.hourglass_top_rounded,
          title: updating
              ? 'Your book is being updated'
              : 'Not ready to share yet',
          message: updating
              ? 'Its PDF is being rebuilt after your latest changes. You can '
                    'share it as soon as that is done, usually within a minute.'
              : 'You can share your book once it has finished and its PDF is '
                    'ready.',
          actionLabel: updating ? 'Try again' : null,
          onAction: updating ? onRetry : null,
        ),
      ],
    );
  }
}
