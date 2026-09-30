import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';
import 'studio_location.dart';
import 'studio_progress.dart';

/// The one sheet every "write it yourself" door opens.
///
/// The casual route — describe a book and the AI writes it — is the app's
/// front door and stays that way; this is the side door for people who want to
/// write the book themselves. A blank sheet to a blinking cursor is two taps:
/// pick what you are writing (a title is optional), then Start writing. A
/// manuscript that is already finished goes the other way, into the import.
///
/// Every door says who does the writing, never who owns the book: a book the
/// AI writes is the reader's own too, and "write your own book" said it wasn't.
Future<void> showStartWritingSheet(BuildContext context) {
  AppHaptics.tap();
  return showAppBottomSheet<void>(
    context,
    builder: (_) => const StartWritingSheet(),
  );
}

@visibleForTesting
class StartWritingSheet extends ConsumerStatefulWidget {
  const StartWritingSheet({super.key});

  @override
  ConsumerState<StartWritingSheet> createState() => _StartWritingSheetState();
}

class _StartWritingSheetState extends ConsumerState<StartWritingSheet> {
  final _title = TextEditingController();
  ManuscriptKind _kind = ManuscriptKind.story;
  bool _starting = false;
  String? _error;

  /// Kept across retries of the same request, so a create the server finished
  /// after the app gave up on it comes back as the same book, not a second one.
  String? _requestId;
  String? _requestFor;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    if (_starting) return;
    final title = _title.text.trim();
    final fingerprint = '${_kind.wire}|$title';
    if (_requestFor != fingerprint) {
      _requestFor = fingerprint;
      _requestId = studioRequestId('studio-create');
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final created = await ref
          .read(studioRepositoryProvider)
          .createBook(
            kind: _kind,
            requestId: _requestId!,
            title: title.isEmpty ? null : title,
            language: _deviceLanguage(context),
          );
      if (!mounted) return;
      ref.invalidate(projectsProvider);
      AppHaptics.success();
      final router = GoRouter.of(context);
      Navigator.of(context).pop();
      // Pushed, never gone to: the page the door was on stays beneath, with
      // the new book's own page between it and the Studio, so back walks
      // Studio → book → wherever the author started. A `go` left the book
      // page alone on the stack, and the next back offered to close the app.
      router
        ..push('/projects/${created.projectId}')
        ..push(
          studioLocation(created.projectId, chapterId: created.chapter.id),
        );
    } catch (error) {
      if (!mounted) return;
      AppHaptics.error();
      setState(() {
        _starting = false;
        _error = userFacingError(error);
      });
    }
  }

  void _import() {
    final router = GoRouter.of(context);
    Navigator.of(context).pop();
    router.push('/books/import');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return AppSheetScaffold(
      title: 'Write it yourself',
      subtitle:
          'You write it, chapter by chapter, with AI tools when you want '
          'them. Nothing is published until you say so.',
      icon: Icons.history_edu_outlined,
      onClose: _starting ? null : () => Navigator.of(context).pop(),
      footer: _footer(context),
      children: [
        const SizedBox(height: AppSpacing.xs),
        TextField(
          key: const ValueKey('start-writing-title'),
          controller: _title,
          enabled: !_starting,
          maxLength: 160,
          maxLengthEnforcement: MaxLengthEnforcement.enforced,
          textCapitalization: TextCapitalization.sentences,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _start(),
          decoration: const InputDecoration(
            labelText: 'Title (optional)',
            hintText: 'You can name it later',
            counterText: '',
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        Text(
          'What are you writing?',
          style: theme.textTheme.labelLarge?.copyWith(
            color: colors.onSurfaceVariant,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        _KindPicker(
          selected: _kind,
          enabled: !_starting,
          onSelected: (kind) {
            AppHaptics.selection();
            setState(() => _kind = kind);
          },
        ),
      ],
    );
  }

  Widget _footer(BuildContext context) {
    return AnimatedSize(
      duration: AppMotion.adapt(context, AppMotion.medium),
      curve: AppMotion.enter,
      alignment: Alignment.topCenter,
      child: _starting
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.xs),
              child: StudioWorkingProgress(
                key: ValueKey('start-writing-progress'),
                semanticLabel: 'Starting your book',
                tau: Duration(seconds: 2),
                stageInterval: Duration(milliseconds: 1400),
                stages: ['Setting up your book', 'Opening your first chapter'],
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null) ...[
                  AppInlineNotice(
                    tone: AppTone.error,
                    title: 'Could not start your book',
                    message: _error!,
                  ),
                  const SizedBox(height: AppSpacing.sm),
                ],
                AppButton.primary(
                  key: const ValueKey('start-writing-button'),
                  label: _error == null ? 'Start writing' : 'Try again',
                  leading: const Icon(Icons.edit_outlined),
                  expanded: true,
                  onPressed: _start,
                ),
                const SizedBox(height: AppSpacing.xxs),
                AppButton.text(
                  key: const ValueKey('start-writing-import'),
                  label: 'Import a manuscript (Word, EPUB, text)',
                  leading: const Icon(Icons.upload_file_outlined),
                  onPressed: _import,
                ),
              ],
            ),
    );
  }
}

/// The language the book is written in, as far as the app can tell before a
/// word exists: the device's. The app's own UI is English-only, so its locale
/// says nothing about the author.
String? _deviceLanguage(BuildContext context) {
  final code = View.of(context).platformDispatcher.locale.languageCode;
  return code.length >= 2 ? code : null;
}

class _KindOption {
  const _KindOption(this.kind, this.icon, this.hint);

  final ManuscriptKind kind;
  final IconData icon;
  final String hint;
}

const _kindOptions = [
  _KindOption(
    ManuscriptKind.story,
    Icons.auto_stories_outlined,
    'Chapters of flowing prose.',
  ),
  _KindOption(
    ManuscriptKind.nonfiction,
    Icons.lightbulb_outline,
    'Guides, memoir, essays, how-to.',
  ),
  _KindOption(
    ManuscriptKind.picture,
    Icons.palette_outlined,
    'A picture on every page, with a few lines of text.',
  ),
  _KindOption(
    ManuscriptKind.other,
    Icons.edit_note_outlined,
    'Poems, a journal, anything else.',
  ),
];

/// Four choices, two to a row: short enough to take in at a glance, with the
/// one line under each that tells a picture book from a story.
class _KindPicker extends StatelessWidget {
  const _KindPicker({
    required this.selected,
    required this.enabled,
    required this.onSelected,
  });

  final ManuscriptKind selected;
  final bool enabled;
  final ValueChanged<ManuscriptKind> onSelected;

  @override
  Widget build(BuildContext context) {
    // Large text leaves half a phone too narrow for a hint; one column then.
    final narrow =
        MediaQuery.textScalerOf(context).scale(1) >= 1.3 ||
        MediaQuery.sizeOf(context).width < 340;
    final tiles = [
      for (final option in _kindOptions)
        _KindTile(
          option: option,
          selected: option.kind == selected,
          onTap: enabled ? () => onSelected(option.kind) : null,
        ),
    ];
    if (narrow) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final tile in tiles) ...[
            tile,
            const SizedBox(height: AppSpacing.xs),
          ],
        ],
      );
    }
    Widget row(Widget a, Widget b) => IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: a),
          const SizedBox(width: AppSpacing.xs),
          Expanded(child: b),
        ],
      ),
    );
    return Column(
      children: [
        row(tiles[0], tiles[1]),
        const SizedBox(height: AppSpacing.xs),
        row(tiles[2], tiles[3]),
      ],
    );
  }
}

class _KindTile extends StatelessWidget {
  const _KindTile({
    required this.option,
    required this.selected,
    required this.onTap,
  });

  final _KindOption option;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final foreground = selected ? colors.onPrimaryContainer : colors.onSurface;
    final support = selected
        ? colors.onPrimaryContainer.withValues(alpha: 0.85)
        : colors.onSurfaceVariant;
    final radius = BorderRadius.circular(AppRadii.control);
    return Semantics(
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: '${option.kind.label}. ${option.hint}',
      onTap: onTap,
      child: ExcludeSemantics(
        child: AppPressScale(
          enabled: onTap != null,
          child: AnimatedContainer(
            duration: AppMotion.adapt(context, AppMotion.fast),
            curve: AppMotion.enter,
            decoration: BoxDecoration(
              color: selected
                  ? colors.primaryContainer
                  : colors.surfaceContainerLow,
              borderRadius: radius,
              border: Border.all(
                color: selected
                    ? colors.primary.withValues(alpha: 0.55)
                    : colors.outlineVariant,
                width: selected ? 1.4 : 1,
              ),
            ),
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                key: ValueKey('start-writing-kind-${option.kind.wire}'),
                borderRadius: radius,
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            option.icon,
                            size: 22,
                            color: selected
                                ? colors.onPrimaryContainer
                                : colors.primary,
                          ),
                          const Spacer(),
                          AnimatedOpacity(
                            opacity: selected ? 1 : 0,
                            duration: AppMotion.adapt(context, AppMotion.fast),
                            child: Icon(
                              Icons.check_circle,
                              size: 18,
                              color: colors.onPrimaryContainer,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        option.kind.label,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          color: foreground,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        option.hint,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: support,
                          height: 1.3,
                        ),
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
