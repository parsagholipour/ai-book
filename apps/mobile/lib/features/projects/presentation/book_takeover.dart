import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../studio/data/studio_repository.dart';
import '../../studio/presentation/studio_progress.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

/// "Continue in Writing Studio": the owner of a finished AI-generated book
/// takes it over as their own manuscript (`.scratch/writing-studio/takeover.md`).
///
/// It lives in Edit Mode's overflow and nowhere else, so the casual route —
/// describe a book, read it — never meets it: the people who open Edit Mode
/// are the people who came to write. The server does the work in one free,
/// synchronous call; this file is the door, the one-time confirmation and the
/// wait.

/// Whether [project] may move into the Studio: a generated book (not already
/// the author's) that has finished — the server asks again under its lock.
bool canContinueInStudio(MobileProjectSummary? project) {
  if (project == null || project.isAuthorManuscript) return false;
  final status = project.status.toLowerCase();
  return status == 'complete' || status == 'review_required';
}

/// The one-time confirmation. Says what changes (the book becomes theirs, the
/// AI stops regenerating it), what stays, that it is free, and that it is one
/// way.
Future<bool> confirmBookTakeover(BuildContext context) {
  return showAppConfirmationDialog(
    context,
    title: 'Continue in the Writing Studio?',
    message:
        'This book becomes yours to write. You\'ll edit it chapter by chapter '
        'in the Writing Studio, with AI tools beside you, and update the book '
        'when you\'re ready. Its text, pictures, cover, chat and characters '
        'all stay. The AI will no longer rewrite the whole book or rebuild it '
        'from a new plan. It\'s free, and it can\'t be undone.',
    confirmLabel: 'Open in Writing Studio',
    cancelLabel: 'Not now',
    icon: Icons.edit_outlined,
  );
}

/// Moves the book and refreshes everything the app knows about it. A server
/// that met another change landing at the same moment (`TAKEOVER_RETRY`)
/// committed nothing, so that one answer is retried once.
Future<void> takeOverBookIntoStudio({
  required ProviderContainer container,
  required String projectId,
  required String requestId,
}) async {
  final studio = container.read(studioRepositoryProvider);
  try {
    await studio.takeOverBook(projectId, requestId: requestId);
  } on ApiException catch (error) {
    if (error.code != 'TAKEOVER_RETRY') rethrow;
    await studio.takeOverBook(projectId, requestId: requestId);
  }
  container
    ..invalidate(projectsProvider)
    ..invalidate(projectDetailProvider(projectId))
    ..invalidate(projectStatusProvider(projectId))
    ..invalidate(projectChatProvider(projectId))
    ..invalidate(manuscriptProvider(projectId));
}

enum _BookEditMenuAction { continueInStudio }

/// Edit Mode's overflow: one quiet item.
class BookTakeoverMenu extends StatelessWidget {
  const BookTakeoverMenu({required this.onContinueInStudio, super.key});

  /// Null while the screen is busy.
  final VoidCallback? onContinueInStudio;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<_BookEditMenuAction>(
      key: const ValueKey('book-edit-menu'),
      tooltip: 'More',
      enabled: onContinueInStudio != null,
      icon: const Icon(Icons.more_vert),
      onSelected: (_) => onContinueInStudio?.call(),
      itemBuilder: (context) => const [
        PopupMenuItem(
          key: ValueKey('book-edit-continue-in-studio'),
          value: _BookEditMenuAction.continueInStudio,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.edit_outlined),
              SizedBox(width: 12),
              Flexible(child: Text('Continue in Writing Studio')),
            ],
          ),
        ),
      ],
    );
  }
}

/// The wait while the book moves: the Studio's paced progress, never a bare
/// spinner.
class BookTakeoverProgress extends StatelessWidget {
  const BookTakeoverProgress({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 32),
        child: StudioWorkingProgress(
          key: ValueKey('book-takeover-progress'),
          stages: [
            'Moving your book into the Writing Studio',
            'Setting out your chapters',
            'Opening the Writing Studio',
          ],
          semanticLabel: 'Moving your book into the Writing Studio',
        ),
      ),
    );
  }
}
