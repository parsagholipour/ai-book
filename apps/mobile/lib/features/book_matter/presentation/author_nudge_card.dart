import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/presentation/book_stage.dart';
import '../data/book_matter_repository.dart';
import '../domain/author_profile.dart';
import '../domain/book_matter.dart';
import '../domain/matter_changes.dart';
import 'author_profile_screen.dart';
import 'matter_form.dart';

/// The profile the book page asks "Put your name on it" against, or null
/// when it should not ask.
///
/// It asks once, ever: on a generated book (an author's own book has its
/// name in the Studio), while that book is being written or once it is
/// finished (ready, or held for review), and only for an author who has neither answered nor set a pen name
/// some other way. A profile that could not be read asks nothing.
AuthorProfile? authorNudgeProfile(
  WidgetRef ref, {
  required MobileProjectDetail? project,
  required BookStage stage,
}) {
  if (project == null ||
      project.isAuthorManuscript ||
      project.manuscript != null) {
    return null;
  }
  // A book finished under a quality hold is as finished as a ready one; leaving
  // it out dropped the card, typed text and all, when writing ended that way.
  const asksDuring = {
    BookStage.writing,
    BookStage.ready,
    BookStage.reviewRequired,
  };
  if (!asksDuring.contains(stage)) return null;
  final value = ref.watch(authorProfileProvider);
  if (value.hasError) return null;
  final profile = value.value;
  return profile != null && profile.wantsSetupPrompt ? profile : null;
}

/// "Put your name on it": the author's pen name, for this book and the ones
/// after it, and a dedication for this one. Inline on the book page, never a
/// dialog, and gone for good after Save or Not now.
///
/// The page keys it (see `BookScreenBody`), so a book that finishes while the
/// author types keeps the card and its words, and it keeps itself alive when
/// scrolled out of view. Its save does not depend on it either: what follows a
/// save goes through the provider container, because the card the save
/// started in is not always the one on the page when it lands.
///
/// A book can already carry a byline or a dedication the profile never heard
/// of — the creation chat's "write it under the name Sam Lee", or a dedication
/// the book chat set while the book was being written. The card reads the
/// book's matter and starts both fields from it, and Save sends the book only
/// the fields the author changed: an untouched field is never sent back, so it
/// can neither replace nor clear what the book prints. The read is the
/// repository's own, not `bookMatterProvider`: watching that would keep it
/// alive under the Title & credits sheet, which reads it fresh each time it
/// opens. A save there is heard through `savedBookMatterProvider` instead, and
/// moves every field still showing the old words to the new ones.
class AuthorNudgeCard extends ConsumerStatefulWidget {
  const AuthorNudgeCard({
    required this.projectId,
    required this.profile,
    super.key,
  });

  final String projectId;
  final AuthorProfile profile;

  @override
  ConsumerState<AuthorNudgeCard> createState() => _AuthorNudgeCardState();
}

class _AuthorNudgeCardState extends ConsumerState<AuthorNudgeCard>
    with AutomaticKeepAliveClientMixin {
  final _penName = TextEditingController();
  final _dedication = TextEditingController();
  bool _saving = false;
  MatterSaveError? _error;

  /// Until the book's matter has been read, Save and the suggestion wait: a
  /// name sent before then could replace a byline the author never saw.
  bool _readingBook = true;

  /// A save's answer arrived while the first read was out, so that read's
  /// answer is older than what the card shows and is dropped.
  bool _heardSave = false;

  /// The byline and dedication this book prints, as the card last read them
  /// or heard a save leave them; null when it has none or its matter could not
  /// be read (then the card asks as if it had none). Each field is compared
  /// with its own: the same words are not a change, and are not sent.
  String? _bookAuthor;
  String? _bookDedication;

  // Small, and gone for good once answered: words typed into it are worth
  // more than the memory, and a save in flight should finish where it began.
  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    unawaited(_readBookMatter());
  }

  Future<void> _readBookMatter() async {
    BookMatter? matter;
    try {
      matter = await ref
          .read(bookMatterRepositoryProvider)
          .getBookMatter(widget.projectId);
    } catch (_) {
      // Unknown, not refused: the card still asks, as it did before it read.
    }
    if (!mounted || _heardSave) return;
    setState(() => _showBook(matter));
  }

  /// A save of this book's matter landed — from the Title & credits sheet, or
  /// this card's own — and this is what the book prints now.
  void _bookSaved(BookMatter? _, BookMatter? matter) {
    if (matter == null || !mounted) return;
    setState(() {
      _heardSave = true;
      _showBook(matter);
    });
  }

  /// Makes [matter] what the card compares against. A field still showing
  /// what the book printed before follows the book; words the author typed
  /// are theirs and stay.
  void _showBook(BookMatter? matter) {
    final author = _trimmedOrNull(matter?.authorName);
    final dedication = _trimmedOrNull(matter?.dedication);
    _follow(_penName, _bookAuthor, author, AuthorProfileLimits.penName);
    _follow(
      _dedication,
      _bookDedication,
      dedication,
      BookMatterLimits.dedication,
    );
    _bookAuthor = author;
    _bookDedication = dedication;
    _readingBook = false;
  }

  static void _follow(
    TextEditingController field,
    String? before,
    String? after,
    int maxLength,
  ) {
    final shown = field.text.trim();
    if (shown != (before ?? '') || shown == (after ?? '')) return;
    field.value = filledFieldValue(after ?? '', maxLength);
  }

  static String? _trimmedOrNull(String? text) {
    final trimmed = text?.trim() ?? '';
    return trimmed.isEmpty ? null : trimmed;
  }

  @override
  void dispose() {
    _penName.dispose();
    _dedication.dispose();
    super.dispose();
  }

  /// Puts the name (and any dedication) on this book first, then saves it to
  /// the profile with the card marked answered, and only then lets the card
  /// go. The book is the half that can refuse — it is busy while it is being
  /// put together, or a word is screened out — and marking the card answered
  /// first would have taken it away for good with this book left unnamed.
  ///
  /// The book is sent only the fields the author changed — a name or a
  /// dedication it prints already is not sent, and an untouched dedication
  /// is neither replaced nor cleared — and when that leaves it nothing to take
  /// its write is skipped: the profile is the whole answer.
  Future<void> _save() async {
    final name = _penName.text.trim();
    if (_saving || _readingBook || name.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _error = null;
    });
    // Everything after the writes goes through what outlives this card: the
    // page may have rebuilt it (or the reader left it) by the time they land,
    // and the profile has to hear the answer either way, or the card stays.
    final container = ProviderScope.containerOf(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final repository = ref.read(bookMatterRepositoryProvider);
    final changes = MatterChanges();
    final update = BookMatterUpdate(
      authorName: changes.text('authorName', _bookAuthor, name),
      dedication: changes.text('dedication', _bookDedication, _dedication.text),
      clear: changes.cleared,
    );
    try {
      final saved = update.isEmpty
          ? null
          : await repository.updateBookMatter(widget.projectId, update);
      // The book has these words now, whatever the profile says next: show
      // them and watch any queued reprint even if the profile write fails.
      // A second Save then sends only what the profile has yet to take.
      if (saved != null) {
        announceBookMatterSaved(container, widget.projectId, saved.bookMatter);
        container
          ..invalidate(projectDetailProvider(widget.projectId))
          ..invalidate(projectsProvider);
        if (saved.reprint == BookMatterReprint.queued) {
          container.invalidate(projectStatusProvider(widget.projectId));
        }
      }
      final profile = await repository.updateAuthorProfile(
        AuthorProfileUpdate(penName: name, setupPromptSeen: true),
      );
      AppHaptics.success();
      if (messenger.mounted) {
        messenger.showAppSnackBar(
          SnackBar(
            key: const ValueKey('author-nudge-saved'),
            content: Text(authorNudgeSavedMessage(name, saved)),
            duration: const Duration(seconds: 6),
            persist: false,
            action: SnackBarAction(
              label: 'Add a bio',
              onPressed: () => router.push(authorProfileLocation),
            ),
          ),
        );
      }
      // Last: the profile now has a pen name, so this takes the card away.
      // A profile nobody is watching any more reads the answer from the
      // server next time.
      if (container.exists(authorProfileProvider)) {
        container.read(authorProfileProvider.notifier).saved(profile);
      }
    } catch (error) {
      if (!mounted) return;
      AppHaptics.error();
      setState(() {
        _saving = false;
        _error = MatterSaveError.from(error);
      });
    }
  }

  void _notNow() {
    AppHaptics.tap();
    ref.read(authorProfileProvider.notifier).dismissSetupPrompt();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    ref.listen<BookMatter?>(
      savedBookMatterProvider(widget.projectId),
      _bookSaved,
    );
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final suggestion = widget.profile.penNameSuggestion;
    final error = _error;
    final hasName = _penName.text.trim().isNotEmpty;
    return AppEntrance(
      offset: 12,
      child: AppCard(
        key: const ValueKey('author-nudge-card'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.primaryContainer.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(AppRadii.compact),
                    ),
                    child: SizedBox.square(
                      dimension: 40,
                      child: Icon(
                        Icons.history_edu_outlined,
                        color: colors.primary,
                        size: 22,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                        header: true,
                        child: Text(
                          'Put your name on it',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'It goes on this book’s title page, and on the books '
                        'you make next.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            MatterTextField(
              fieldKey: 'nudge-pen-name',
              controller: _penName,
              label: 'Your name or pen name',
              hint: suggestion,
              errorText:
                  error?.errorFor('penName') ?? error?.errorFor('authorName'),
              maxLength: AuthorProfileLimits.penName,
              capitalization: TextCapitalization.words,
              enabled: !_saving,
              onChanged: (_) => setState(() {}),
            ),
            if (suggestion != null && !hasName && !_readingBook)
              PenNameSuggestion(
                suggestion: suggestion,
                onUse: () => setState(() {
                  _penName.value = filledFieldValue(
                    suggestion,
                    AuthorProfileLimits.penName,
                  );
                }),
              ),
            MatterTextField(
              fieldKey: 'nudge-dedication',
              controller: _dedication,
              label: 'Dedication for this book (optional)',
              hint: 'For…',
              errorText: error?.errorFor('dedication'),
              maxLength: BookMatterLimits.dedication,
              maxLines: 3,
              enabled: !_saving,
            ),
            if (error != null) ...[
              MatterSaveErrorNotice(error: error),
              const SizedBox(height: AppSpacing.sm),
            ],
            Wrap(
              alignment: WrapAlignment.end,
              spacing: AppSpacing.xs,
              runSpacing: AppSpacing.xs,
              children: [
                AppButton.text(
                  key: const ValueKey('nudge-not-now'),
                  label: 'Not now',
                  onPressed: _saving ? null : _notNow,
                ),
                AppButton.tonal(
                  key: const ValueKey('nudge-save'),
                  label: 'Save',
                  loading: _saving,
                  loadingLabel: 'Saving',
                  onPressed: hasName && !_readingBook ? _save : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// What the book page says once the name is on the book. [saved] is null when
/// the book already printed that name and was sent nothing.
String authorNudgeSavedMessage(String name, BookMatterSaved? saved) {
  final cover = saved?.cover == BookMatterCover.keepsOldName
      ? ' Your cover was drawn before names could be re-set, so it keeps the '
            'old name.'
      : '';
  return '“$name” is on this book now, and on the ones you make next.$cover';
}
