import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/presentation/project_chat_screen.dart';
import '../domain/reader_models.dart';

/// What the reader can do with a selected passage.
enum ReaderSelectionAction { copy, ask, rewrite, replace, editPage, share }

/// Composes the chat message for a rewrite request.
///
/// The page number and the quoted excerpt are both load-bearing: the API's
/// intent classifier reads the page from `page N` and the passage from the
/// quotes, which is how a selection in a continuously-rendered PDF becomes an
/// edit against a specific book page.
///
/// [pageIndex] is null when the passage could not be placed. The quote still
/// goes through — the server can often find it, and where it cannot the chat
/// asks rather than the reader hitting a dead end.
String readerRewriteMessage({
  required int? pageIndex,
  required String excerpt,
  required String instruction,
}) {
  final trimmed = instruction.trim();
  final base = pageIndex == null
      ? 'Rewrite this passage: "$excerpt".'
      : 'On page $pageIndex, rewrite this passage: "$excerpt".';
  return trimmed.isEmpty ? base : '$base $trimmed';
}

/// Composes the chat message for an exact replacement.
///
/// Two quoted terms in this order are what the API turns into an
/// `exact_replace` patch rather than a full rewrite.
String readerReplaceMessage({
  required int? pageIndex,
  required String from,
  required String to,
}) {
  final replacement = 'replace "${from.trim()}" with "${to.trim()}".';
  return pageIndex == null
      ? 'In the book, $replacement'
      : 'On page $pageIndex, $replacement';
}

/// Prefills the chat composer with the passage the reader asked about.
String readerAskDraft({required int? pageIndex, required String excerpt}) {
  return pageIndex == null
      ? 'About this passage: "$excerpt" — '
      : 'About page $pageIndex: "$excerpt" — ';
}

/// Runs a selection action, sending edits through the existing chat pipeline.
///
/// Edits are deliberately not confirmed here: sending the message and then
/// opening the book chat keeps one place where a priced proposal is reviewed,
/// applied and undone.
Future<void> runReaderSelectionAction({
  required BuildContext context,
  required String projectId,
  required ReaderSelection selection,
  required ReaderSelectionAction action,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final router = GoRouter.of(context);

  switch (action) {
    case ReaderSelectionAction.copy:
      await Clipboard.setData(ClipboardData(text: selection.text));
      AppHaptics.tap();
      messenger.showAppSnackBar(
        const SnackBar(content: Text('Passage copied.')),
      );

    case ReaderSelectionAction.share:
      await SharePlus.instance.share(ShareParams(text: selection.text));

    case ReaderSelectionAction.ask:
      router.push(
        '/projects/$projectId/chat',
        extra: ProjectChatLaunch(
          draft: readerAskDraft(
            pageIndex: selection.bookPageIndex,
            excerpt: selection.excerpt,
          ),
        ),
      );

    case ReaderSelectionAction.editPage:
      // Without a page the editor still opens, on its first page, rather than
      // the action doing nothing.
      final pageIndex = selection.bookPageIndex;
      router.push(
        pageIndex == null
            ? '/projects/$projectId/edit'
            : '/projects/$projectId/edit?pageIndex=$pageIndex',
      );

    case ReaderSelectionAction.rewrite:
      final instruction = await _promptForInstruction(context, selection);
      if (instruction == null || !context.mounted) return;
      _sendEdit(
        router: router,
        projectId: projectId,
        message: readerRewriteMessage(
          pageIndex: selection.bookPageIndex,
          excerpt: selection.excerpt,
          instruction: instruction,
        ),
      );

    case ReaderSelectionAction.replace:
      final replacement = await _promptForReplacement(context, selection);
      if (replacement == null || !context.mounted) return;
      _sendEdit(
        router: router,
        projectId: projectId,
        message: readerReplaceMessage(
          pageIndex: selection.bookPageIndex,
          from: replacement.from,
          to: replacement.to,
        ),
      );
  }
}

/// Hands the edit to the book chat and goes there straight away.
///
/// The chat sends it through its own optimistic path, so the pending bubble,
/// the retry on failure and the priced proposal all appear where the user is
/// already looking. Awaiting the request here instead left them staring at the
/// book for however long it took.
void _sendEdit({
  required GoRouter router,
  required String projectId,
  required String message,
}) {
  AppHaptics.tap();
  router.push(
    '/projects/$projectId/chat',
    extra: ProjectChatLaunch(send: message),
  );
}

Future<String?> _promptForInstruction(
  BuildContext context,
  ReaderSelection selection,
) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (_) => ReaderInstructionSheet(
      excerpt: selection.excerpt,
      placement: selection.placementLabel,
    ),
  );
}

Future<({String from, String to})?> _promptForReplacement(
  BuildContext context,
  ReaderSelection selection,
) {
  return showModalBottomSheet<({String from, String to})>(
    context: context,
    isScrollControlled: true,
    builder: (_) => ReaderReplacementSheet(
      excerpt: selection.excerpt,
      placement: selection.placementLabel,
    ),
  );
}

/// The changes people actually ask for, as one tap each.
///
/// A blank "how should it change?" box is a small essay question, and most
/// rewrites are one of a handful of things. Tapping a chip sends immediately;
/// the field is still there for anything else.
const readerRewritePresets = <String>[
  'Make it shorter',
  'Make it simpler',
  'Make it warmer',
  'Make it more vivid',
  'Fix the grammar',
  'Add more detail',
];

/// Asks how a passage should be rewritten.
///
/// The sheet owns its controller so it is disposed when the sheet actually
/// leaves the tree. Disposing it when the sheet's future completes — which
/// happens the moment the route is popped, while the field is still on screen
/// animating out — tears down a controller the live [TextField] is still
/// attached to, and the framework trips over the half-dismantled subtree.
class ReaderInstructionSheet extends StatefulWidget {
  const ReaderInstructionSheet({
    required this.excerpt,
    this.placement,
    super.key,
  });

  final String excerpt;

  /// The book page the rewrite will name, shown so the target is visible
  /// before the message is sent.
  final String? placement;

  @override
  State<ReaderInstructionSheet> createState() => _ReaderInstructionSheetState();
}

class _ReaderInstructionSheetState extends State<ReaderInstructionSheet> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit([String? value]) {
    Navigator.of(context).pop(value ?? _controller.text);
  }

  @override
  Widget build(BuildContext context) {
    return _SelectionSheet(
      title: 'Rewrite this passage',
      excerpt: widget.excerpt,
      placement: widget.placement,
      submitLabel: 'Send to book chat',
      onSubmit: _submit,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final preset in readerRewritePresets)
              ActionChip(
                label: Text(preset),
                onPressed: () {
                  AppHaptics.selection();
                  _submit(preset);
                },
              ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _controller,
          maxLines: 3,
          minLines: 1,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(
            labelText: 'Or say it in your own words',
            hintText: 'Give the second half more rhythm',
          ),
          onSubmitted: _submit,
        ),
      ],
    );
  }
}

/// Asks what a passage should be replaced with.
///
/// Owns its controllers for the same reason as [ReaderInstructionSheet].
class ReaderReplacementSheet extends StatefulWidget {
  const ReaderReplacementSheet({
    required this.excerpt,
    this.placement,
    super.key,
  });

  final String excerpt;

  /// The book page the replacement will name.
  final String? placement;

  @override
  State<ReaderReplacementSheet> createState() => _ReaderReplacementSheetState();
}

class _ReaderReplacementSheetState extends State<ReaderReplacementSheet> {
  late final _fromController = TextEditingController(text: widget.excerpt);
  final _toController = TextEditingController();

  @override
  void dispose() {
    _fromController.dispose();
    _toController.dispose();
    super.dispose();
  }

  void _submit() {
    final from = _fromController.text.trim();
    final to = _toController.text.trim();
    if (from.isEmpty || to.isEmpty) {
      return;
    }
    Navigator.of(context).pop((from: from, to: to));
  }

  @override
  Widget build(BuildContext context) {
    return _SelectionSheet(
      title: 'Replace text',
      excerpt: widget.excerpt,
      placement: widget.placement,
      submitLabel: 'Send to book chat',
      onSubmit: _submit,
      children: [
        TextField(
          controller: _fromController,
          maxLines: 2,
          minLines: 1,
          decoration: const InputDecoration(labelText: 'Replace'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _toController,
          autofocus: true,
          maxLines: 2,
          minLines: 1,
          decoration: const InputDecoration(labelText: 'With'),
        ),
      ],
    );
  }
}

class _SelectionSheet extends StatelessWidget {
  const _SelectionSheet({
    required this.title,
    required this.excerpt,
    required this.submitLabel,
    required this.onSubmit,
    required this.children,
    this.placement,
  });

  final String title;
  final String excerpt;
  final String? placement;
  final String submitLabel;
  final VoidCallback onSubmit;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final placement = this.placement;
    // Scrollable because the sheet grew: the rewrite presets, the excerpt and
    // the field together are taller than a short screen with the keyboard up,
    // and a bottom sheet that overflows renders as a stripe of error rather
    // than as something the reader can reach the button in.
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        20,
        20,
        20,
        20 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: theme.textTheme.titleMedium),
          if (placement != null) ...[
            const SizedBox(height: 4),
            Text(
              placement,
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              excerpt,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ),
          const SizedBox(height: 16),
          ...children,
          const SizedBox(height: 20),
          FilledButton(onPressed: onSubmit, child: Text(submitLabel)),
        ],
      ),
    );
  }
}
