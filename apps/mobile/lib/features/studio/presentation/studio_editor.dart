import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../projects/domain/chat_text_direction.dart';
import '../domain/manuscript_formatting.dart';
import 'chapter_conflict_card.dart';
import 'studio_ai_picture_card.dart';
import 'studio_ai_tools_sheet.dart' show StudioSelectionTool;
import 'studio_document.dart';
import 'studio_image_block.dart';
import 'studio_picture_pages.dart';
import 'studio_session.dart';

export 'studio_ai_tools_sheet.dart' show StudioSelectionTool;

/// What the editor asks of the screen: the things that open sheets or pick
/// photos, which a scrolling column of fields cannot do itself.
abstract interface class StudioEditorHost {
  /// Picture from the photo library or camera, into the chapter at [offset]
  /// of [entry] (at the end when [entry] is null).
  void insertPicture(StudioTextEntry? entry, int? offset);

  /// Picture into the picture slot of page [pageIndex].
  void addPagePicture(int pageIndex);

  void replacePicture(StudioImageEntry entry);

  /// Delete page [pageIndex], offering an undo.
  void deletePage(int pageIndex);

  void compareBookConflict();

  /// A writing-assistant tool on the text selected in [entry].
  void runSelectionTool(StudioTextEntry entry, StudioSelectionTool tool);

  /// Another try at a picture the AI could not draw (priced on the card).
  void retryAiPicture(StudioAiPictureEntry entry);

  /// Takes out a picture the AI could not draw.
  void removeAiPicture(StudioAiPictureEntry entry);

  /// "Plan my chapters with AI", from a blank book's empty page.
  void planChaptersWithAi();
}

/// The reading column the author writes in: the chapter's title, then its
/// text segments and the picture and chart cards between them — or, for a
/// picture book, one card per page.
class StudioEditor extends StatelessWidget {
  const StudioEditor({required this.session, required this.host, super.key});

  final StudioSession session;
  final StudioEditorHost host;

  /// The widest the text runs; beyond it lines get too long to read.
  static const double maxTextWidth = 680;

  @override
  Widget build(BuildContext context) {
    final document = session.document;
    if (document == null || session.switching) {
      return const StudioEditorSkeleton();
    }
    return ListenableBuilder(
      listenable: document,
      builder: (context, _) =>
          _EditorBody(session: session, document: document, host: host),
    );
  }
}

class _EditorBody extends StatelessWidget {
  const _EditorBody({
    required this.session,
    required this.document,
    required this.host,
  });

  final StudioSession session;
  final StudioDocument document;
  final StudioEditorHost host;

  TextDirection? _fallbackDirection() {
    final sample = '${document.title.text}\n${document.textEntries.first.text}';
    final hint = chatTextDirection(sample);
    if (hint != null) {
      return hint == TextDirectionHint.rtl
          ? TextDirection.rtl
          : TextDirection.ltr;
    }
    final language = (session.manuscript?.language ?? '').toLowerCase();
    const rtl = {'fa', 'ar', 'he', 'ur', 'ps', 'ckb', 'yi', 'dv', 'ug'};
    return rtl.contains(language.split(RegExp('[-_]')).first)
        ? TextDirection.rtl
        : null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final width = MediaQuery.sizeOf(context).width;
    final gutter = width < 480 ? 22.0 : 32.0;
    final bodyStyle = studioBodyStyle(context);
    final direction = _fallbackDirection();
    final picture = document.isPictureLayout;
    final conflict = session.bookConflict;

    final content = <Widget>[
      _ChapterHeading(
        session: session,
        document: document,
        direction: direction,
      ),
      if (picture)
        StudioPicturePages(
          projectId: session.projectId,
          document: document,
          host: host,
          bodyStyle: bodyStyle,
          direction: direction,
        )
      else
        ..._flowEntries(context, bodyStyle, direction),
      if (session.isBlankStudioBook)
        ValueListenableBuilder<int>(
          valueListenable: session.chapterWords,
          builder: (context, words, _) => words > 0
              ? const SizedBox.shrink()
              : StudioPlanWithAiCard(
                  pictureBook: picture,
                  onTap: host.planChaptersWithAi,
                ),
        ),
      _TapToContinue(document: document),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (conflict != null)
          Padding(
            padding: EdgeInsets.fromLTRB(gutter, AppSpacing.sm, gutter, 0),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: StudioEditor.maxTextWidth,
                ),
                child: ChapterConflictCard(
                  busy: session.saveState == StudioSaveState.saving,
                  onKeepMine: session.keepMineOverBook,
                  onUseBook: session.useBookVersion,
                  onCompare: host.compareBookConflict,
                ),
              ),
            ),
          ),
        Expanded(
          child: ColoredBox(
            color: colors.surface,
            child: SingleChildScrollView(
              key: const PageStorageKey('studio-editor-scroll'),
              padding: EdgeInsets.fromLTRB(gutter, AppSpacing.lg, gutter, 0),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: StudioEditor.maxTextWidth,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: content,
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  List<Widget> _flowEntries(
    BuildContext context,
    TextStyle bodyStyle,
    TextDirection? direction,
  ) {
    final entries = document.entries;
    final empty = document.markdown.isEmpty;
    final widgets = <Widget>[];
    for (var i = 0; i < entries.length; i++) {
      final entry = entries[i];
      final key = ValueKey('studio-entry-${entry.id}');
      switch (entry) {
        case StudioTextEntry():
          final first = i == 0;
          // A blank segment between two pictures is only somewhere to put
          // the cursor; it should not read as a gap in the chapter.
          final gap = !first && entry.isBlank && i < entries.length - 1;
          widgets.add(
            Padding(
              key: key,
              padding: EdgeInsets.symmetric(vertical: gap ? 0 : 2),
              child: StudioTextField(
                entry: entry,
                style: bodyStyle,
                fallbackDirection: direction,
                hint: first && empty ? 'Start writing…' : null,
                onAiTool: (tool) => host.runSelectionTool(entry, tool),
              ),
            ),
          );
        case StudioImageEntry():
          widgets.add(
            Padding(
              key: key,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              child: StudioImageBlock(
                entry: entry,
                canMoveUp: document.canMoveUp(entry),
                canMoveDown: document.canMoveDown(entry),
                onAction: (action) => _onImageAction(entry, action),
              ),
            ),
          );
        case StudioUploadEntry():
          widgets.add(
            Padding(
              key: key,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              child: StudioUploadingBlock(entry: entry),
            ),
          );
        case StudioAiPictureEntry():
          widgets.add(
            Padding(
              key: key,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              child: StudioAiPictureCard(
                entry: entry,
                projectId: session.projectId,
                onRetry: () => host.retryAiPicture(entry),
                onRemove: () => host.removeAiPicture(entry),
              ),
            ),
          );
        case StudioFigureEntry():
          widgets.add(
            Padding(
              key: key,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              child: StudioFigureCard(entry: entry),
            ),
          );
        case StudioPageBreakEntry():
          widgets.add(_FlowPageBreak(key: key));
      }
    }
    return widgets;
  }

  void _onImageAction(StudioImageEntry entry, StudioImageAction action) {
    switch (action) {
      case StudioImageAction.replace:
        host.replacePicture(entry);
      case StudioImageAction.moveUp:
        document.moveEntry(entry, up: true);
      case StudioImageAction.moveDown:
        document.moveEntry(entry, up: false);
      case StudioImageAction.remove:
        document.removeEntry(entry);
    }
  }
}

/// The body text style: generous, book-like reading typography.
TextStyle studioBodyStyle(BuildContext context) {
  final theme = Theme.of(context);
  return theme.textTheme.bodyLarge!.copyWith(
    fontSize: 18,
    height: 1.62,
    letterSpacing: 0.05,
    color: theme.colorScheme.onSurface,
  );
}

/// One text segment: a borderless, growing field with the live markdown
/// styling. Its direction follows its own first strong character, so a
/// Persian paragraph reads from the right even in an English book.
class StudioTextField extends StatefulWidget {
  const StudioTextField({
    required this.entry,
    required this.style,
    this.hint,
    this.fallbackDirection,
    this.onAiTool,
    super.key,
  });

  final StudioTextEntry entry;
  final TextStyle style;
  final String? hint;
  final TextDirection? fallbackDirection;

  /// The writing assistant's selection tools, led into the field's own
  /// selection menu (Copy, Cut, Paste, Select all stay).
  final ValueChanged<StudioSelectionTool>? onAiTool;

  /// From this width the menu has room for each tool by name; narrower, one
  /// "AI" item opens them all in a sheet, so Copy and Paste stay in view.
  static const double roomyMenuWidth = 600;

  @override
  State<StudioTextField> createState() => _StudioTextFieldState();
}

class _StudioTextFieldState extends State<StudioTextField> {
  TextDirectionHint? _hint;

  @override
  void initState() {
    super.initState();
    _hint = chatTextDirection(widget.entry.text);
    widget.entry.controller.addListener(_textChanged);
  }

  @override
  void didUpdateWidget(StudioTextField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.entry != widget.entry) {
      oldWidget.entry.controller.removeListener(_textChanged);
      widget.entry.controller.addListener(_textChanged);
      _hint = chatTextDirection(widget.entry.text);
    }
  }

  @override
  void dispose() {
    widget.entry.controller.removeListener(_textChanged);
    super.dispose();
  }

  void _textChanged() {
    final hint = chatTextDirection(widget.entry.text);
    if (hint != _hint) setState(() => _hint = hint);
  }

  /// The platform's selection menu, led by the writing assistant's tools
  /// when there is a selection to work on.
  Widget _contextMenu(BuildContext context, EditableTextState state) {
    final onAiTool = widget.onAiTool;
    final selection = state.textEditingValue.selection;
    final system = state.contextMenuButtonItems;
    if (onAiTool == null || !selection.isValid || selection.isCollapsed) {
      return AdaptiveTextSelectionToolbar.buttonItems(
        anchors: state.contextMenuAnchors,
        buttonItems: system,
      );
    }
    final tools =
        MediaQuery.sizeOf(context).width >= StudioTextField.roomyMenuWidth
        ? const [
            StudioSelectionTool.rewrite,
            StudioSelectionTool.fix,
            StudioSelectionTool.illustrate,
            StudioSelectionTool.ask,
          ]
        : const [StudioSelectionTool.more];
    return AdaptiveTextSelectionToolbar.buttonItems(
      anchors: state.contextMenuAnchors,
      buttonItems: [
        for (var i = 0; i < tools.length; i++)
          ContextMenuButtonItem(
            // The sparkle leads the group, so the four read as one set.
            label: i == 0 && tools[i] != StudioSelectionTool.more
                ? '✨ ${tools[i].label}'
                : tools[i].label,
            onPressed: () {
              state.hideToolbar();
              onAiTool(tools[i]);
            },
          ),
        ...system,
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final direction = switch (_hint) {
      TextDirectionHint.rtl => TextDirection.rtl,
      TextDirectionHint.ltr => TextDirection.ltr,
      null => widget.fallbackDirection,
    };
    return TextField(
      // A structural rewrite of this segment starts its undo history over
      // (`StudioTextEntry.historyEpoch`); the focus node is the entry's own, so
      // focus survives the rebuild.
      key: ValueKey(widget.entry.historyEpoch),
      controller: widget.entry.controller,
      focusNode: widget.entry.focusNode,
      undoController: widget.entry.undo,
      contextMenuBuilder: _contextMenu,
      keyboardType: TextInputType.multiline,
      maxLines: null,
      textCapitalization: TextCapitalization.sentences,
      textDirection: direction,
      inputFormatters: const [ManuscriptEnterFormatter()],
      style: widget.style,
      // A strut far below any real line: each line takes its height from its
      // own spans, which is what lets a blank line (a paragraph break) draw
      // at half height. `StrutStyle.disabled` does not do this here: the
      // field fills its unset font size in from the text style, and a strut
      // of the body font holds every blank line at the body's natural height.
      strutStyle: const StrutStyle(fontSize: 1, height: 1, leading: 0),
      cursorWidth: 2,
      scrollPadding: const EdgeInsets.fromLTRB(20, 20, 20, 72),
      decoration: studioBareDecoration(
        context,
        hint: widget.hint,
        hintStyle: widget.style.copyWith(
          color: colors.onSurfaceVariant.withValues(alpha: 0.6),
        ),
      ),
    );
  }
}

class _ChapterHeading extends StatelessWidget {
  const _ChapterHeading({
    required this.session,
    required this.document,
    required this.direction,
  });

  final StudioSession session;
  final StudioDocument document;
  final TextDirection? direction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final picture = document.isPictureLayout;
    final label = picture
        ? 'Picture book'
        : 'Chapter ${session.chapterPosition}';
    final titleStyle = theme.textTheme.headlineMedium?.copyWith(
      fontWeight: FontWeight.w800,
      letterSpacing: -0.6,
      height: 1.2,
      color: colors.onSurface,
    );
    final heading = Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            label.toUpperCase(),
            textDirection: direction,
            style: theme.textTheme.labelMedium?.copyWith(
              color: colors.primary,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          TextField(
            key: const ValueKey('studio-title-field'),
            controller: document.title,
            focusNode: document.titleFocus,
            maxLines: null,
            maxLength: 200,
            textDirection: direction,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.next,
            style: titleStyle,
            onSubmitted: (_) =>
                document.textEntries.first.focusNode.requestFocus(),
            decoration: studioBareDecoration(
              context,
              hint: 'Chapter title',
              hintStyle: titleStyle?.copyWith(
                color: colors.onSurfaceVariant.withValues(alpha: 0.45),
              ),
            ).copyWith(counterText: ''),
          ),
          const SizedBox(height: AppSpacing.md),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Container(
              width: 40,
              height: 3,
              decoration: BoxDecoration(
                color: colors.primary.withValues(alpha: 0.35),
                borderRadius: BorderRadius.circular(AppRadii.pill),
              ),
            ),
          ),
        ],
      ),
    );
    // The label, the title and the rule under it start where the chapter's
    // text starts: on the right in a Persian book.
    final textDirection = direction;
    return textDirection == null
        ? heading
        : Directionality(textDirection: textDirection, child: heading);
  }
}

/// A page separator left in a flow chapter (from a layout switch). The flow
/// layout has no mid-chapter page break; publish reads it as a paragraph
/// break.
class _FlowPageBreak extends StatelessWidget {
  const _FlowPageBreak({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Row(
        children: [
          Expanded(child: Divider(color: colors.outlineVariant)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
            child: Text(
              'Page break',
              style: Theme.of(
                context,
              ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ),
          Expanded(child: Divider(color: colors.outlineVariant)),
        ],
      ),
    );
  }
}

/// The empty space under the last line: a tap there puts the cursor at the
/// end of the chapter, the way a page of paper would.
class _TapToContinue extends StatelessWidget {
  const _TapToContinue({required this.document});

  final StudioDocument document;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: () {
        final last = document.lastText;
        last.focusNode.requestFocus();
        last.controller.selection = TextSelection.collapsed(
          offset: last.controller.text.length,
        );
      },
      child: SizedBox(height: MediaQuery.sizeOf(context).height * 0.3),
    );
  }
}

/// A blank book's one quiet offer: plan the chapters with AI. Shown only while
/// a book begun in the Studio has a single, empty chapter.
class StudioPlanWithAiCard extends StatelessWidget {
  const StudioPlanWithAiCard({
    required this.pictureBook,
    required this.onTap,
    super.key,
  });

  final bool pictureBook;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.xl),
      child: Material(
        key: const ValueKey('studio-plan-with-ai'),
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.card),
          onTap: onTap,
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadii.card),
              border: Border.all(color: colors.outlineVariant),
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Row(
                children: [
                  Icon(Icons.auto_awesome_outlined, color: colors.primary),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          pictureBook
                              ? 'Plan my story with AI'
                              : 'Plan my chapters with AI',
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          pictureBook
                              ? 'Say what your book is about and get a '
                                    'page-by-page plan in your notes.'
                              : 'Say what your book is about and get an '
                                    'outline — titles and notes — to write '
                                    'from.',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(
                    Icons.chevron_right_rounded,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The editor's shape while a chapter loads: a title and a few paragraphs.
class StudioEditorSkeleton extends StatelessWidget {
  const StudioEditorSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final gutter = width < 480 ? 22.0 : 32.0;
    return AppSkeletonGroup(
      label: 'Opening your chapter',
      child: Padding(
        padding: EdgeInsets.fromLTRB(gutter, AppSpacing.lg, gutter, 0),
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: StudioEditor.maxTextWidth,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const AppSkeleton.line(width: 84, height: 10),
                const SizedBox(height: AppSpacing.sm),
                const AppSkeleton.line(widthFactor: 0.62, height: 26),
                const SizedBox(height: AppSpacing.xl),
                for (final factor in const [0.72, 0.9, 0.55, 0.8]) ...[
                  const AppSkeleton.line(widthFactor: 1, height: 12),
                  const SizedBox(height: AppSpacing.sm),
                  const AppSkeleton.line(widthFactor: 0.96, height: 12),
                  const SizedBox(height: AppSpacing.sm),
                  AppSkeleton.line(widthFactor: factor, height: 12),
                  const SizedBox(height: AppSpacing.lg),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
