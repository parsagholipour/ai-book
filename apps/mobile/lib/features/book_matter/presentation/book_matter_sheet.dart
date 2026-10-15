import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/data/projects_repository.dart';
import '../data/book_matter_repository.dart';
import '../domain/book_matter.dart';
import 'made_with_credit_line.dart';
import 'matter_form.dart';

/// Opens one book's Title & credits. Resolves with the server's answer to a
/// save — what it does to the book's files and cover — or null when the
/// sheet closed without one.
Future<BookMatterSaved?> showBookMatterSheet(
  BuildContext context, {
  required String projectId,
}) {
  return showAppBottomSheet<BookMatterSaved>(
    context,
    // Flutter's drag-to-dismiss pops the sheet directly, past the form's
    // "Discard changes?". The close button, a tap above the sheet and Back
    // all ask first, so they are the ways out; with no drag there is no
    // handle to show either, as in the character editor.
    enableDrag: false,
    showDragHandle: false,
    builder: (_) => Padding(
      // The room above the heading that the drag handle used to make.
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: BookMatterSheet(projectId: projectId),
    ),
  );
}

const _title = 'Title & credits';
const _subtitle =
    'The title page, dedication and About the author in this '
    'book.';

/// The sheet: the book's matter once it has loaded, its shape until then.
class BookMatterSheet extends ConsumerWidget {
  const BookMatterSheet({required this.projectId, super.key});

  final String projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(bookMatterProvider(projectId));
    final matter = value.value;
    if (matter != null && !value.hasError) {
      return BookMatterForm(projectId: projectId, matter: matter);
    }
    return AppSheetScaffold(
      title: _title,
      subtitle: _subtitle,
      icon: Icons.history_edu_outlined,
      onClose: () => Navigator.of(context).pop(),
      children: [
        if (value.hasError)
          AppErrorState(
            compact: true,
            title: 'Couldn’t load this book’s credits',
            message: 'Check your connection and try again.',
            onRetry: () => ref.invalidate(bookMatterProvider(projectId)),
          )
        else
          const _MatterSkeleton(),
      ],
    );
  }
}

/// The fields, once the book's matter is here. Only what the author changed
/// is sent, and an emptied field is sent as a clear.
@visibleForTesting
class BookMatterForm extends ConsumerStatefulWidget {
  const BookMatterForm({
    required this.projectId,
    required this.matter,
    super.key,
  });

  final String projectId;
  final BookMatter matter;

  @override
  ConsumerState<BookMatterForm> createState() => _BookMatterFormState();
}

class _BookMatterFormState extends ConsumerState<BookMatterForm> {
  late final _author = TextEditingController(
    text: widget.matter.authorName ?? '',
  );
  late final _dedication = TextEditingController(
    text: widget.matter.dedication ?? '',
  );
  late final _about = TextEditingController(
    text: widget.matter.aboutAuthor ?? '',
  );
  late final _website = TextEditingController(
    text: widget.matter.authorWebsite ?? '',
  );
  late final _holder = TextEditingController(
    text: widget.matter.copyrightHolder ?? '',
  );
  late final _imprint = TextEditingController(
    text: widget.matter.imprint ?? '',
  );
  late final _isbn = TextEditingController(text: widget.matter.isbn ?? '');
  late final _edits = Listenable.merge([
    _author,
    _dedication,
    _about,
    _website,
    _holder,
    _imprint,
    _isbn,
  ]);
  late bool _allRightsReserved = widget.matter.allRightsReserved;
  bool _publishingOpen = false;
  bool _saving = false;
  MatterSaveError? _error;

  /// What the fields are compared with: the matter the sheet opened with, or
  /// what a save left the book as while the sheet stayed up.
  late BookMatter _matter = widget.matter;

  static const _publishingFields = {'copyrightHolder', 'imprint', 'isbn'};

  bool get _studioOwned => _matter.studioOwned;

  @override
  void didUpdateWidget(covariant BookMatterForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.matter != widget.matter) _matter = widget.matter;
  }

  @override
  void dispose() {
    for (final controller in [
      _author,
      _dedication,
      _about,
      _website,
      _holder,
      _imprint,
      _isbn,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  String get _publishingSummary {
    final holder = _holder.text.trim();
    final parts = [
      if (holder.isNotEmpty) '© $holder',
      if (_imprint.text.trim().isNotEmpty) _imprint.text.trim(),
      if (_isbn.text.trim().isNotEmpty)
        'ISBN ${isbnWithoutLabel(_isbn.text.trim())}',
      if (_allRightsReserved) 'All rights reserved',
    ];
    return parts.isEmpty
        ? 'Copyright holder, imprint, ISBN'
        : parts.join(' · ');
  }

  String get _holderHint {
    final author = _studioOwned
        ? _matter.authorName?.trim() ?? ''
        : _author.text.trim();
    return author.isEmpty ? 'The author name' : author;
  }

  /// What the author changed here, or null when nothing has.
  BookMatterUpdate? get _changes => bookMatterChanges(
    _matter,
    authorName: _studioOwned ? null : _author.text,
    dedication: _studioOwned ? null : _dedication.text,
    aboutAuthor: _about.text,
    authorWebsite: _website.text,
    copyrightHolder: _holder.text,
    imprint: _imprint.text,
    isbn: _isbn.text,
    allRightsReserved: _allRightsReserved,
  );

  /// Whether leaving would throw typed words away. A save in flight would
  /// not: its words are on their way, and the sheet may go while it lands.
  bool get _hasUnsavedEdits => !_saving && _changes != null;

  /// A removal that is reprinting the book closes the sheet, the way a save
  /// does, so the page shows the refresh — unless the sheet holds typed words
  /// it would throw away, or is no longer the page on top.
  bool _creditRemoved(BookMatterCreditRemoval removal) {
    if (removal.reprint != BookMatterReprint.queued ||
        _saving ||
        _changes != null) {
      return false;
    }
    // A removal lands whenever the server answers. A sheet already sliding
    // out, or under the plans, would pop what is on top instead: the book
    // page, landing the reader back in the library.
    if (ModalRoute.of(context)?.isCurrent != true) return false;
    Navigator.of(context).pop();
    return true;
  }

  Future<void> _save() async {
    if (_saving) return;
    final update = _changes;
    final navigator = Navigator.of(context);
    if (update == null) {
      navigator.pop();
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _error = null;
    });
    // A sheet can be tapped away while it saves, and the save still lands:
    // everything that has to follow it goes through what outlives the sheet.
    // Its state outlives its route by the length of the slide out, so
    // `mounted` alone does not say the sheet is still there.
    final container = ProviderScope.containerOf(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final route = ModalRoute.of(context);
    try {
      final saved = await container
          .read(bookMatterRepositoryProvider)
          .updateBookMatter(widget.projectId, update);
      // The byline is on the book page and in the library; a settled book
      // also has new work now, and its status stream closed when it settled.
      // The page's setup card read this book's byline and dedication before
      // the sheet changed them.
      container
        ..invalidate(projectDetailProvider(widget.projectId))
        ..invalidate(projectsProvider);
      announceBookMatterSaved(container, widget.projectId, saved.bookMatter);
      if (saved.reprint == BookMatterReprint.queued) {
        container.invalidate(projectStatusProvider(widget.projectId));
      }
      AppHaptics.success();
      if (mounted && route?.isCurrent == true) {
        navigator.pop(saved);
        return;
      }
      // Nobody is waiting on the sheet any more, so the page says it. A
      // sheet still sliding out must not pop: what is on top now is the book
      // page.
      if (messenger.mounted) {
        messenger.showAppSnackBar(bookMatterSavedSnackBar(saved));
      }
      // A sheet still up under something else holds the book's words now.
      if (mounted) {
        setState(() {
          _saving = false;
          _matter = saved.bookMatter;
        });
      }
    } catch (error) {
      AppHaptics.error();
      final saveError = MatterSaveError.from(error);
      if (!mounted || route?.isActive == false) {
        // The typed words went with the sheet; at least say they did not
        // reach the book.
        if (messenger.mounted) {
          messenger.showAppSnackBar(
            SnackBar(
              key: const ValueKey('book-matter-not-saved'),
              content: Text(bookMatterNotSavedMessage(saveError)),
            ),
          );
        }
        return;
      }
      setState(() {
        _saving = false;
        _error = saveError;
        if (saveError.fields.any(_publishingFields.contains)) {
          _publishingOpen = true;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    return MatterLeaveGuard(
      edits: _edits,
      hasUnsavedEdits: () => _hasUnsavedEdits,
      message: 'Your changes to this book’s Title & credits haven’t been saved.',
      child: _form(context, error),
    );
  }

  Widget _form(BuildContext context, MatterSaveError? error) {
    return AppSheetScaffold(
      title: _title,
      subtitle: _subtitle,
      icon: Icons.history_edu_outlined,
      // Through the leave guard, like a tap above the sheet or Back.
      onClose: _saving ? null : () => Navigator.of(context).maybePop(),
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (error != null) ...[
            MatterSaveErrorNotice(error: error),
            const SizedBox(height: AppSpacing.sm),
          ],
          AppButton.primary(
            key: const ValueKey('matter-save'),
            label: 'Save',
            loading: _saving,
            loadingLabel: 'Saving',
            expanded: true,
            onPressed: _save,
          ),
        ],
      ),
      children: [
        const SizedBox(height: AppSpacing.xs),
        if (_studioOwned) ...[
          const MatterNote(
            key: ValueKey('matter-studio-note'),
            icon: Icons.edit_note_outlined,
            text:
                'The author name and dedication are set in the Writing '
                'Studio’s book settings.',
          ),
          const SizedBox(height: AppSpacing.lg),
        ] else ...[
          MatterTextField(
            fieldKey: 'matter-author',
            controller: _author,
            label: 'Author name',
            hint: 'Your name, or a pen name',
            helper: 'On the title page: “by …”.',
            errorText: error?.errorFor('authorName'),
            maxLength: BookMatterLimits.authorName,
            capitalization: TextCapitalization.words,
            enabled: !_saving,
            onChanged: (_) => setState(() {}),
          ),
          MatterTextField(
            fieldKey: 'matter-dedication',
            controller: _dedication,
            label: 'Dedication',
            hint: 'For…',
            helper: 'Optional. On the page after the title page.',
            errorText: error?.errorFor('dedication'),
            maxLength: BookMatterLimits.dedication,
            maxLines: 4,
            enabled: !_saving,
          ),
        ],
        MatterTextField(
          fieldKey: 'matter-about',
          controller: _about,
          label: 'About the author',
          hint: 'A few lines about you.',
          helper: 'Leave it empty and the book has no About the author page.',
          errorText: error?.errorFor('aboutAuthor'),
          maxLength: BookMatterLimits.aboutAuthor,
          minLines: 3,
          maxLines: 8,
          showCounter: true,
          enabled: !_saving,
        ),
        MatterTextField(
          fieldKey: 'matter-website',
          controller: _website,
          label: 'Website',
          hint: 'yourname.com',
          helper: 'Printed under About the author.',
          errorText: error?.errorFor('authorWebsite'),
          maxLength: BookMatterLimits.authorWebsite,
          keyboardType: TextInputType.url,
          capitalization: TextCapitalization.none,
          autocorrect: false,
          enabled: !_saving,
        ),
        MatterDisclosure(
          toggleKey: const ValueKey('matter-publishing-toggle'),
          title: 'Publishing details',
          summary: _publishingSummary,
          open: _publishingOpen,
          onToggle: () => setState(() => _publishingOpen = !_publishingOpen),
          children: [
            MatterTextField(
              fieldKey: 'matter-holder',
              controller: _holder,
              label: 'Copyright holder',
              hint: _holderHint,
              helper: 'Leave empty to use the author name.',
              errorText: error?.errorFor('copyrightHolder'),
              maxLength: BookMatterLimits.copyrightHolder,
              capitalization: TextCapitalization.words,
              enabled: !_saving,
              onChanged: (_) => setState(() {}),
            ),
            MatterTextField(
              fieldKey: 'matter-imprint',
              controller: _imprint,
              label: 'Imprint or publisher',
              hint: 'Optional — “Moonlit Press”',
              errorText: error?.errorFor('imprint'),
              maxLength: BookMatterLimits.imprint,
              capitalization: TextCapitalization.words,
              enabled: !_saving,
              onChanged: (_) => setState(() {}),
            ),
            MatterTextField(
              fieldKey: 'matter-isbn',
              controller: _isbn,
              label: 'ISBN',
              hint: 'Optional — 978-…',
              errorText: error?.errorFor('isbn'),
              maxLength: BookMatterLimits.isbn,
              inputFormatters: const [
                IsbnTextInputFormatter(BookMatterLimits.isbn),
              ],
              capitalization: TextCapitalization.characters,
              autocorrect: false,
              enabled: !_saving,
              onChanged: (_) => setState(() {}),
            ),
            AppToggleTile(
              key: const ValueKey('matter-rights'),
              value: _allRightsReserved,
              onChanged: _saving
                  ? (_) {}
                  : (value) {
                      AppHaptics.selection();
                      setState(() => _allRightsReserved = value);
                    },
              icon: Icons.copyright_outlined,
              title: 'Print “All rights reserved”',
              subtitle: _allRightsReserved
                  ? 'On this book’s copyright page.'
                  : 'This book makes no rights statement.',
            ),
          ],
        ),
        MadeWithCreditLine(
          projectId: widget.projectId,
          matter: _matter,
          hasUnsavedChanges: () => _saving || _changes != null,
          onRemoved: _creditRemoved,
        ),
      ],
    );
  }
}

/// The confirmation after a save: where the change will show. A cover that
/// keeps its old name is news worth a longer look.
SnackBar bookMatterSavedSnackBar(BookMatterSaved saved) {
  return SnackBar(
    key: const ValueKey('book-matter-saved'),
    content: Text(saved.message),
    duration: saved.cover == BookMatterCover.keepsOldName
        ? const Duration(seconds: 8)
        : const Duration(seconds: 4),
  );
}

/// What the page says when a save refused after its sheet was tapped away.
/// The marked fields went with the sheet, so a refusal says so in words; any
/// other refusal (an invalid ISBN) already names its field in its sentence.
String bookMatterNotSavedMessage(MatterSaveError error) {
  final reason = error.unprintable && error.fields.isNotEmpty
      ? 'Some of it can’t be printed in a book.'
      : error.message;
  return 'Your Title & credits changes weren’t saved. $reason';
}

/// The form's shape while the book's matter loads.
class _MatterSkeleton extends StatelessWidget {
  const _MatterSkeleton();

  @override
  Widget build(BuildContext context) {
    return const AppSkeletonGroup(
      label: 'Loading this book’s credits',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: AppSpacing.xs),
          AppSkeleton.box(height: 56),
          SizedBox(height: AppSpacing.lg),
          AppSkeleton.box(height: 88),
          SizedBox(height: AppSpacing.lg),
          AppSkeleton.box(height: 104),
          SizedBox(height: AppSpacing.lg),
          AppSkeleton.line(widthFactor: 0.5, height: 16),
        ],
      ),
    );
  }
}
