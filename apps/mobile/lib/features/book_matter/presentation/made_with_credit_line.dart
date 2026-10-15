import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../projects/data/projects_repository.dart';
import '../data/book_matter_repository.dart';
import '../domain/book_matter.dart';
import 'matter_form.dart';

/// What the Title & credits sheet offers about the free tier's
/// "Made with Tomeza" line.
///
/// Subscribing never reprints anyone's books. A book printed on the free
/// tier keeps the line until its owner, now on a plan, takes it off — free,
/// one book at a time.
enum MadeWithCreditOffer {
  /// A free account: its next build prints the line. Say so, quietly, and
  /// offer the plans.
  plans,

  /// A subscriber whose book's files still carry the line: take it off.
  remove,

  /// Neither: there is no line, and none is coming.
  none;

  static MadeWithCreditOffer of(BookMatter matter) => MadeWithCreditOffer.from(
    madeWithCredit: matter.madeWithCredit,
    creditPrinted: matter.creditPrinted,
  );

  static MadeWithCreditOffer from({
    required bool madeWithCredit,
    required bool creditPrinted,
  }) {
    if (madeWithCredit) return plans;
    return creditPrinted ? remove : none;
  }
}

/// The server's own sentence for a free account, shown over the plans when
/// the reader opens them from here rather than being refused.
const madeWithCreditPlanMessage =
    'Removing the “Made with Tomeza” line comes with any plan.';

/// The "Made with Tomeza" line in a book's Title & credits sheet: what the
/// book carries, and the one thing the reader can do about it.
///
/// It keeps its own copy of the two flags it reads, because what it learns —
/// a refusal saying the plan is gone, a purchase, a removal — is newer than
/// the matter the sheet was opened with, and re-reading the sheet's provider
/// would put the half-typed form at the mercy of a network error.
class MadeWithCreditLine extends ConsumerStatefulWidget {
  const MadeWithCreditLine({
    required this.projectId,
    required this.matter,
    this.hasUnsavedChanges,
    this.onRemoved,
    super.key,
  });

  final String projectId;
  final BookMatter matter;

  /// Whether the sheet holds typed changes not yet saved. A removal reprints
  /// the book, and a book being reprinted refuses the save that would follow
  /// it — so the typed words are saved first, and the removal waits.
  final bool Function()? hasUnsavedChanges;

  /// Told about a removal while the sheet is still up. Answers true when it
  /// closed the sheet — the page then says what happened — and false when the
  /// sheet stays, so this line says it in place.
  final bool Function(BookMatterCreditRemoval removal)? onRemoved;

  @override
  ConsumerState<MadeWithCreditLine> createState() => _MadeWithCreditLineState();
}

class _MadeWithCreditLineState extends ConsumerState<MadeWithCreditLine> {
  late bool _madeWithCredit = widget.matter.madeWithCredit;
  late bool _creditPrinted = widget.matter.creditPrinted;

  /// Removing the line, or reading the book again after a purchase.
  bool _busy = false;
  BookMatterCreditRemoval? _removed;
  String? _error;
  bool _saveFirst = false;

  MadeWithCreditOffer get _offer => MadeWithCreditOffer.from(
    madeWithCredit: _madeWithCredit,
    creditPrinted: _creditPrinted,
  );

  @override
  void didUpdateWidget(covariant MadeWithCreditLine oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_busy && _removed == null && oldWidget.matter != widget.matter) {
      _madeWithCredit = widget.matter.madeWithCredit;
      _creditPrinted = widget.matter.creditPrinted;
    }
  }

  Future<void> _remove({bool afterPurchase = false}) async {
    if (_busy) return;
    if (widget.hasUnsavedChanges?.call() ?? false) {
      setState(() {
        _saveFirst = true;
        _error = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _saveFirst = false;
      _error = null;
    });
    // The sheet can be tapped away while this is in flight, and the removal
    // still lands: what has to follow it goes through what outlives the sheet.
    final container = ProviderScope.containerOf(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final route = ModalRoute.of(context);
    final BookMatterCreditRemoval removal;
    try {
      removal = await container
          .read(bookMatterRepositoryProvider)
          .removeTomezaCredit(widget.projectId);
    } catch (error) {
      await _failed(
        error,
        messenger,
        afterPurchase: afterPurchase,
        gone: _gone(route),
      );
      return;
    }
    final queued = removal.reprint == BookMatterReprint.queued;
    if (queued) {
      // A settled book has new work now, and its status stream closed when
      // it settled: the page has to open it again to show the refresh.
      container
        ..invalidate(projectStatusProvider(widget.projectId))
        ..invalidate(projectDetailProvider(widget.projectId))
        ..invalidate(projectsProvider);
    }
    AppHaptics.success();
    final gone = _gone(route);
    if ((queued || gone) && messenger.mounted) {
      messenger.showAppSnackBar(
        SnackBar(
          key: const ValueKey('book-matter-credit-removed'),
          content: Text(removal.message),
        ),
      );
    }
    if (gone || (widget.onRemoved?.call(removal) ?? false)) return;
    setState(() {
      _busy = false;
      _removed = removal;
      _madeWithCredit = removal.bookMatter.madeWithCredit;
    });
  }

  /// Whether the sheet has closed or is closing: its state outlives its route
  /// by the length of the slide out, and says nothing in place any more.
  bool _gone(ModalRoute<Object?>? route) =>
      !mounted || route?.isActive == false;

  Future<void> _failed(
    Object error,
    ScaffoldMessengerState messenger, {
    required bool afterPurchase,
    required bool gone,
  }) async {
    // A closing sheet opens no plans over the page it leaves.
    if (gone) {
      if (messenger.mounted) {
        messenger.showAppSnackBar(
          SnackBar(
            key: const ValueKey('book-matter-credit-not-removed'),
            content: Text(
              '“Made with Tomeza” wasn’t removed. ${userFacingError(error)}',
            ),
          ),
        );
      }
      return;
    }
    if (error is ApiException &&
        error.code == 'SUBSCRIPTION_REQUIRED' &&
        !afterPurchase) {
      // This sheet read a plan the account no longer has. The line now reads
      // as a free book's does, and the plans are offered with the server's
      // own sentence — the same answer as tapping "See plans".
      setState(() {
        _busy = false;
        _madeWithCredit = true;
      });
      await _openPlans(error.message, continueRemoval: true);
      return;
    }
    AppHaptics.error();
    setState(() {
      _busy = false;
      // A 409 says why — the book is unfinished, or busy — in its own words.
      _error = userFacingError(error);
    });
  }

  /// The plans, over this sheet. A purchase there is followed by reading the
  /// book again — the server says whether it bought a plan, not this sheet —
  /// and, when the reader had asked to remove the line, by removing it.
  Future<void> _openPlans(
    String message, {
    bool continueRemoval = false,
  }) async {
    final container = ProviderScope.containerOf(context, listen: false);
    final purchase = await showBillingPaywall(
      context,
      projectId: widget.projectId,
      message: message,
      trigger: PaywallTrigger.madeWithCredit,
    );
    container.invalidate(billingProvider);
    if (purchase == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final fresh = await container
          .read(bookMatterRepositoryProvider)
          .getBookMatter(widget.projectId);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _madeWithCredit = fresh.madeWithCredit;
        _creditPrinted = fresh.creditPrinted;
      });
    } catch (_) {
      // The line keeps saying what it said; the sheet opened again reads it.
      if (mounted) setState(() => _busy = false);
      return;
    }
    if (continueRemoval && _offer == MadeWithCreditOffer.remove) {
      await _remove(afterPurchase: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final removed = _removed;
    final Widget content;
    if (removed != null) {
      content = MatterNote(
        key: const ValueKey('matter-credit-removed'),
        icon: Icons.check_circle_outline,
        text: removed.sheetNote,
      );
    } else {
      switch (_offer) {
        case MadeWithCreditOffer.none:
          return const SizedBox.shrink();
        case MadeWithCreditOffer.plans:
          content = _LineWithAction(
            note: const MatterNote(
              key: ValueKey('matter-credit-note'),
              text:
                  'Free books carry a small “Made with Tomeza” line on the '
                  'copyright page. Any plan lets you take it off.',
            ),
            action: AppButton.text(
              key: const ValueKey('matter-credit-plans'),
              label: 'See plans',
              loading: _busy,
              loadingLabel: 'Checking your plan',
              onPressed: () {
                AppHaptics.tap();
                _openPlans(madeWithCreditPlanMessage);
              },
            ),
          );
        case MadeWithCreditOffer.remove:
          content = _LineWithAction(
            note: const MatterNote(
              key: ValueKey('matter-credit-printed'),
              text:
                  'This book’s files still carry a small “Made with Tomeza” '
                  'line on the copyright page. Your plan removes it, free.',
            ),
            action: AppButton.text(
              key: const ValueKey('matter-credit-remove'),
              label: 'Remove it',
              loading: _busy,
              loadingLabel: 'Removing',
              onPressed: () {
                AppHaptics.tap();
                _remove();
              },
            ),
            notice: _notice,
          );
      }
    }
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.md),
      child: AnimatedSize(
        duration: AppMotion.adapt(context, AppMotion.fast),
        curve: AppMotion.standard,
        alignment: Alignment.topCenter,
        child: content,
      ),
    );
  }

  Widget? get _notice {
    final error = _error;
    if (error != null) {
      return AppInlineNotice(
        key: const ValueKey('matter-credit-error'),
        tone: AppTone.error,
        title: 'Couldn’t remove it',
        message: error,
      );
    }
    if (_saveFirst) {
      return const AppInlineNotice(
        key: ValueKey('matter-credit-save-first'),
        tone: AppTone.info,
        title: 'Save your changes first',
        message:
            'Removing the line refreshes this book’s files, and a book takes '
            'one change at a time. Removing it stays free afterwards.',
      );
    }
    return null;
  }
}

/// A quiet note with its one action under it, lined up with the note's
/// words rather than its glyph.
class _LineWithAction extends StatelessWidget {
  const _LineWithAction({
    required this.note,
    required this.action,
    this.notice,
  });

  final Widget note;
  final Widget action;
  final Widget? notice;

  @override
  Widget build(BuildContext context) {
    final notice = this.notice;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        note,
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: Padding(
            // The note's glyph and gap, less the text button's own padding.
            padding: const EdgeInsetsDirectional.only(start: AppSpacing.xxs),
            child: action,
          ),
        ),
        if (notice != null) ...[const SizedBox(height: AppSpacing.xs), notice],
      ],
    );
  }
}
