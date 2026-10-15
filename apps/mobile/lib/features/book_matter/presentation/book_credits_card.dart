import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import 'book_matter_sheet.dart';

/// The book page's door to its Title & credits: the author name, the
/// dedication, About the author and the publishing details of this book.
///
/// Quiet like the notes card beside it — one row, no filled button — because
/// it is something a reader sets once, not what the page is about.
class BookCreditsCard extends StatelessWidget {
  const BookCreditsCard({required this.projectId, super.key});

  final String projectId;

  Future<void> _open(BuildContext context) async {
    AppHaptics.tap();
    final messenger = ScaffoldMessenger.of(context);
    final saved = await showBookMatterSheet(context, projectId: projectId);
    if (saved == null) return;
    messenger.showAppSnackBar(bookMatterSavedSnackBar(saved));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return AppCard(
      key: const ValueKey('book-credits-card'),
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.xs,
        AppSpacing.xxs,
        AppSpacing.xxs,
        AppSpacing.xxs,
      ),
      child: Semantics(
        container: true,
        button: true,
        label: 'Title and credits. Author name, dedication, About the author',
        onTap: () => _open(context),
        child: ExcludeSemantics(
          child: InkWell(
            key: const ValueKey('book-credits-open'),
            onTap: () => _open(context),
            borderRadius: BorderRadius.circular(AppRadii.compact),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.xs,
                  vertical: AppSpacing.xs,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.history_edu_outlined,
                      size: 20,
                      color: colors.primary,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Title & credits',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Author name, dedication, About the author',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xxs),
                    Icon(
                      Icons.chevron_right,
                      size: 20,
                      color: colors.onSurfaceVariant,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
