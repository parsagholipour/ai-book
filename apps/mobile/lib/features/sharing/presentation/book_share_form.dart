import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../domain/book_share_models.dart';
import 'book_share_live.dart' show bookShareSheetTitle;
import 'book_share_progress.dart';

/// A refusal shown above the button: what went wrong, in the server's words.
class BookShareRefusal {
  const BookShareRefusal({required this.title, required this.message});

  final String title;
  final String message;
}

/// A save in flight, as the button paces it.
class BookShareSaving {
  const BookShareSaving({required this.stages, this.slow = false});

  final List<String> stages;
  final bool slow;
}

/// How many pages a first preview offers, when the cap allows that many.
const defaultBookSharePreviewPages = 10;

/// The share's settings: Preview or Full, how many pages a preview shows, the
/// note, the name, and the confirmations a public link needs. It makes a new
/// share and changes a live one; the sheet owns the save and hands back what
/// the server refused, which lands beside the control it is about.
class BookShareForm extends ConsumerStatefulWidget {
  const BookShareForm({
    required this.book,
    required this.editing,
    required this.onSubmit,
    required this.onGetCredits,
    required this.onClose,
    this.previous,
    this.saving,
    this.captionError,
    this.refusal,
    this.notice,
    this.askRights = false,
    this.askLikeness = false,
    this.onCancel,
    this.onCaptionEdited,
    super.key,
  });

  final BookShareBook book;

  /// A live share is being changed rather than a new one made. Its rights
  /// confirmation is on record, so it is not asked again unless the server
  /// says otherwise ([askRights]); the likeness one is asked whenever the
  /// share does not carry it ([BookShare.likenessConfirmed], [askLikeness]).
  final bool editing;

  /// The share to start from: the live one, or a stopped one whose settings
  /// are offered back.
  final BookShare? previous;
  final BookShareSaving? saving;

  /// The server's sentence about the note, shown under the note field.
  final String? captionError;
  final BookShareRefusal? refusal;

  /// A line about what just happened, e.g. that sharing stopped.
  final String? notice;
  final bool askRights;
  final bool askLikeness;
  final ValueChanged<BookShareRequest> onSubmit;

  /// Full on a locked book with a balance that does not cover the unlock.
  final VoidCallback onGetCredits;
  final VoidCallback onClose;

  /// Back to the live share, when there is one.
  final VoidCallback? onCancel;
  final VoidCallback? onCaptionEdited;

  static const rightsLabel = 'I have the right to share this book publicly';
  static const likenessLabel =
      'This book features someone drawn from a real photo. Anyone with the '
      'link can see it.';

  @override
  ConsumerState<BookShareForm> createState() => _BookShareFormState();
}

class _BookShareFormState extends ConsumerState<BookShareForm> {
  late BookShareMode _mode;
  late int _pages;
  late final TextEditingController _caption;
  late bool _showName;
  bool _rights = false;
  bool _likeness = false;
  bool _showConsentError = false;

  @override
  void initState() {
    super.initState();
    final previous = widget.previous;
    final cap = widget.book.previewCap;
    _mode = previous?.mode ?? BookShareMode.preview;
    _pages = (previous?.previewPages ?? defaultBookSharePreviewPages).clamp(
      1,
      cap,
    );
    // A note a moderator removed is not offered back to be sent again.
    final removed = previous?.captionStatus == BookShareCaptionStatus.removed;
    _caption = TextEditingController(
      text: removed ? '' : previous?.caption ?? '',
    );
    _showName = previous?.showAuthorName ?? false;
  }

  @override
  void didUpdateWidget(covariant BookShareForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A re-read can shrink the cap under the stepper (an edit shortened the
    // book): the count follows it down rather than offering a refused value.
    final cap = widget.book.previewCap;
    if (_pages > cap) _pages = cap;
  }

  @override
  void dispose() {
    _caption.dispose();
    super.dispose();
  }

  bool get _needsRights => !widget.editing || widget.askRights;

  /// Asked up front unless the live share being changed already has the
  /// confirmation on record; [BookShareForm.askLikeness] is the fallback for
  /// a server that says otherwise.
  bool get _needsLikeness {
    if (!widget.book.likenessRequired) return false;
    final previous = widget.previous;
    final onRecord =
        (previous?.isActive ?? false) && previous!.likenessConfirmed;
    return !onRecord || widget.askLikeness;
  }

  void _submit({required bool shortOfCredits}) {
    FocusScope.of(context).unfocus();
    if ((_needsRights && !_rights) || (_needsLikeness && !_likeness)) {
      AppHaptics.error();
      setState(() => _showConsentError = true);
      return;
    }
    if (shortOfCredits) {
      widget.onGetCredits();
      return;
    }
    widget.onSubmit(
      BookShareRequest(
        mode: _mode,
        previewPages: _mode == BookShareMode.preview ? _pages : null,
        caption: _caption.text,
        showAuthorName: _showName,
        rightsConfirmed: _rights,
        likenessConfirmed: _likeness,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final book = widget.book;
    final saving = widget.saving;
    final available = ref.watch(billingProvider).value?.credits.available;
    final lockedFull = _mode == BookShareMode.full && !book.exportUnlocked;
    final price = book.exportUnlockCredits;
    final shortOfCredits = lockedFull && available != null && available < price;
    final notice = widget.notice;

    final label = shortOfCredits
        ? 'Get credits'
        : lockedFull
        ? (widget.editing ? 'Unlock and save' : 'Unlock and share')
        : widget.editing
        ? 'Save changes'
        : _mode == BookShareMode.preview
        ? 'Share preview'
        : 'Share full book';

    return AppSheetScaffold(
      title: bookShareSheetTitle,
      subtitle: widget.editing
          ? 'Change what readers get from your link.'
          : 'Anyone with the link can read it. It is not listed anywhere.',
      icon: Icons.link_rounded,
      onClose: widget.onClose,
      footer: _footer(
        label: label,
        lockedFull: lockedFull,
        shortOfCredits: shortOfCredits,
      ),
      children: [
        IgnorePointer(
          ignoring: saving != null,
          child: AnimatedOpacity(
            opacity: saving != null ? 0.55 : 1,
            duration: AppMotion.adapt(context, AppMotion.fast),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (notice != null) ...[
                  AppInlineNotice(title: notice, message: _noticeDetail),
                  const SizedBox(height: AppSpacing.md),
                ],
                SegmentedButton<BookShareMode>(
                  key: const ValueKey('book-share-mode'),
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(
                      value: BookShareMode.preview,
                      icon: Icon(Icons.menu_book_outlined),
                      label: Text('Preview'),
                    ),
                    ButtonSegment(
                      value: BookShareMode.full,
                      icon: Icon(Icons.auto_stories_outlined),
                      label: Text('Full book'),
                    ),
                  ],
                  selected: {_mode},
                  onSelectionChanged: (selection) {
                    AppHaptics.selection();
                    setState(() => _mode = selection.first);
                  },
                ),
                const SizedBox(height: AppSpacing.sm),
                AnimatedSize(
                  duration: AppMotion.adapt(context, AppMotion.medium),
                  curve: AppMotion.enter,
                  alignment: Alignment.topCenter,
                  child: _mode == BookShareMode.preview
                      ? _previewPages(book)
                      : _fullBook(book, available, shortOfCredits),
                ),
                const SizedBox(height: AppSpacing.lg),
                TextField(
                  key: const ValueKey('book-share-caption'),
                  controller: _caption,
                  maxLength: bookShareCaptionMaxChars,
                  maxLengthEnforcement: MaxLengthEnforcement.enforced,
                  minLines: 2,
                  maxLines: 5,
                  textCapitalization: TextCapitalization.sentences,
                  onChanged: widget.captionError == null
                      ? null
                      : (_) => widget.onCaptionEdited?.call(),
                  decoration: InputDecoration(
                    labelText: 'Note beside your book (optional)',
                    hintText: 'Who it’s for, or why you made it',
                    helperText: 'Checked before it’s shown. No links.',
                    helperMaxLines: 2,
                    errorText: widget.captionError,
                    errorMaxLines: 4,
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                AppToggleTile(
                  value: _showName,
                  onChanged: (value) => setState(() => _showName = value),
                  icon: Icons.badge_outlined,
                  title: 'Show my name',
                  subtitle: _showName
                      ? 'Your name appears beside the book.'
                      : 'The page does not say who shared it.',
                ),
                if (_needsRights || _needsLikeness) ...[
                  const SizedBox(height: AppSpacing.md),
                  _Confirmations(
                    rights: _needsRights ? _rights : null,
                    likeness: _needsLikeness ? _likeness : null,
                    showError: _showConsentError,
                    onRights: (value) => setState(() => _rights = value),
                    onLikeness: (value) => setState(() => _likeness = value),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _footer({
    required String label,
    required bool lockedFull,
    required bool shortOfCredits,
  }) {
    final saving = widget.saving;
    final refusal = widget.refusal;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (refusal != null) ...[
          AppInlineNotice(
            key: const ValueKey('book-share-refusal'),
            tone: AppTone.error,
            title: refusal.title,
            message: refusal.message,
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        AppSwitcher(
          child: saving != null
              ? BookShareSavingProgress(
                  key: const ValueKey('saving'),
                  stages: saving.stages,
                  slow: saving.slow,
                )
              : AppButton.primary(
                  key: const ValueKey('book-share-submit'),
                  label: label,
                  leading: Icon(
                    shortOfCredits
                        ? Icons.toll_outlined
                        : lockedFull
                        ? Icons.lock_open_outlined
                        : Icons.link_rounded,
                  ),
                  expanded: true,
                  onPressed: () => _submit(shortOfCredits: shortOfCredits),
                ),
        ),
        if (widget.onCancel != null && saving == null) ...[
          const SizedBox(height: AppSpacing.xxs),
          AppButton.text(label: 'Cancel', onPressed: widget.onCancel),
        ],
      ],
    );
  }

  String get _noticeDetail =>
      'Sharing again makes a new link. Your settings are here as you left '
      'them.';

  void _stepPages(int by, int cap) {
    AppHaptics.selection();
    setState(() => _pages = (_pages + by).clamp(1, cap));
  }

  Widget _previewPages(BookShareBook book) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final cap = book.previewCap;
    final total = book.readingPages;
    final count = total == null
        ? bookSharePageCount(_pages)
        : '$_pages of $total pages';
    return Column(
      key: const ValueKey('book-share-preview'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Previews are free. Readers get the cover and contents, then the '
          'pages you choose.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        Text(
          'Pages in the preview',
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: AppSpacing.xxs),
        Row(
          children: [
            IconButton.outlined(
              tooltip: 'Fewer pages',
              onPressed: _pages > 1 ? () => _stepPages(-1, cap) : null,
              icon: const Icon(Icons.remove),
            ),
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  count,
                  key: const ValueKey('book-share-page-count'),
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
            IconButton.outlined(
              tooltip: 'More pages',
              onPressed: _pages < cap ? () => _stepPages(1, cap) : null,
              icon: const Icon(Icons.add),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.xxs),
        Text(
          'A preview can show up to half the book: '
          '${bookSharePageCount(cap)}.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  /// The price of a full share, worded as the download words its unlock
  /// (`projectExportStateText`), because it is the same unlock.
  Widget _fullBook(BookShareBook book, int? available, bool shortOfCredits) {
    final theme = Theme.of(context);
    if (book.exportUnlocked) {
      return Text(
        'Readers can read the whole book. This book is already unlocked, so '
        'sharing it in full costs nothing more.',
        key: const ValueKey('book-share-full'),
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }
    final price = book.exportUnlockCredits;
    return AppInlineNotice(
      key: const ValueKey('book-share-unlock'),
      tone: AppTone.info,
      icon: Icons.lock_outline,
      title: 'Full sharing uses the export unlock',
      message: shortOfCredits
          ? 'Ready after export unlock. You need $price credits and have '
                '$available. Previews are free.'
          : 'Ready after export unlock. This uses $price credits — the same '
                'unlock the PDF download takes, so this book’s downloads are '
                'included too. Previews are free.',
    );
  }
}

/// The statements a public link needs, unticked until the author ticks them.
/// Null leaves a row out.
class _Confirmations extends StatelessWidget {
  const _Confirmations({
    required this.rights,
    required this.likeness,
    required this.showError,
    required this.onRights,
    required this.onLikeness,
  });

  final bool? rights;
  final bool? likeness;
  final bool showError;
  final ValueChanged<bool> onRights;
  final ValueChanged<bool> onLikeness;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final missing = rights == false || likeness == false;
    final flagged = showError && missing;
    final rows = <Widget>[
      if (rights != null)
        _ConfirmRow(
          key: const ValueKey('book-share-rights'),
          label: BookShareForm.rightsLabel,
          checked: rights!,
          flagged: showError && rights == false,
          onChanged: onRights,
        ),
      if (likeness != null)
        _ConfirmRow(
          key: const ValueKey('book-share-likeness'),
          label: BookShareForm.likenessLabel,
          checked: likeness!,
          flagged: showError && likeness == false,
          onChanged: onLikeness,
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // A Material, not a decorated box: the rows' ink has to land on it.
        Material(
          color: colors.surfaceContainerLowest,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.control),
            side: BorderSide(
              color: flagged ? colors.error : colors.outlineVariant,
            ),
          ),
          child: Column(
            children: [
              for (var i = 0; i < rows.length; i++) ...[
                if (i > 0) Divider(height: 1, color: colors.outlineVariant),
                rows[i],
              ],
            ],
          ),
        ),
        if (flagged) ...[
          const SizedBox(height: AppSpacing.xs),
          Semantics(
            liveRegion: true,
            child: Text(
              rows.length > 1
                  ? 'Confirm both statements to share your book.'
                  : 'Confirm the statement above to share your book.',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.error),
            ),
          ),
        ],
      ],
    );
  }
}

class _ConfirmRow extends StatelessWidget {
  const _ConfirmRow({
    required this.label,
    required this.checked,
    required this.flagged,
    required this.onChanged,
    super.key,
  });

  final String label;
  final bool checked;
  final bool flagged;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return CheckboxListTile(
      value: checked,
      isError: flagged,
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: const EdgeInsetsDirectional.only(
        start: AppSpacing.xxs,
        end: AppSpacing.md,
      ),
      title: Text(label, style: Theme.of(context).textTheme.bodyMedium),
      onChanged: (value) {
        AppHaptics.selection();
        onChanged(value ?? false);
      },
    );
  }
}
