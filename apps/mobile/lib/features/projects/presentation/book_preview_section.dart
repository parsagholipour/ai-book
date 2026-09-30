import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/authed_network_image.dart';
import '../domain/project_models.dart';

// What has actually been written so far — pages and visuals as they land —
// plus the reporting affordances that have to sit beside AI-generated content.

class GeneratedBookPreview extends StatefulWidget {
  const GeneratedBookPreview({
    required this.project,
    this.onReportProject,
    this.onReportImage,
    this.live = false,
    super.key,
  });

  final MobileProjectDetail project;
  final Future<void> Function()? onReportProject;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  /// A book still being written shows the pages that landed last; a finished
  /// one shows how it opens. Either way the rest is a tap away.
  final bool live;

  @override
  State<GeneratedBookPreview> createState() => _GeneratedBookPreviewState();
}

class _GeneratedBookPreviewState extends State<GeneratedBookPreview> {
  /// Enough to show what the writing is like. A finished book is read in the
  /// reader; listing all of its pages here pushed everything below it off the
  /// screen.
  static const _collapsedCount = 3;
  bool _showAll = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final project = widget.project;
    final onReportImage = widget.onReportImage;
    final all = project.pages
        .where(
          (page) =>
              page.previewText.trim().isNotEmpty || page.summary.isNotEmpty,
        )
        .toList();
    final collapsible = all.length > _collapsedCount;
    final pages = !collapsible || _showAll
        ? all
        : widget.live
        ? all.sublist(all.length - _collapsedCount)
        : all.sublist(0, _collapsedCount);
    final cover = project.coverImage;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              'Book preview',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          // An author's own book is their writing, not generated content.
          if (!project.isAuthorManuscript) ...[
            const SizedBox(height: AppSpacing.xxs),
            Text(
              'AI-generated content from your prompt and selected preset.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
          if (widget.onReportProject != null)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: AppButton.text(
                onPressed: () => widget.onReportProject!(),
                leading: const Icon(Icons.flag_outlined),
                label: 'Report book',
              ),
            ),
          const SizedBox(height: AppSpacing.sm),
          if (cover != null) ...[
            _CoverRow(
              image: cover,
              onReport: onReportImage == null
                  ? null
                  : () => onReportImage(cover),
            ),
            const Divider(height: AppSpacing.lg),
          ],
          if (all.isEmpty)
            Text(
              project.isAuthorManuscript
                  ? 'Your pages will appear here once the book is published.'
                  : 'Generated pages will appear here as soon as writing starts.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            )
          else ...[
            for (final page in pages) ...[
              _GeneratedPagePreview(page: page, onReportImage: onReportImage),
              if (page != pages.last) const Divider(height: AppSpacing.lg),
            ],
            if (collapsible) ...[
              const SizedBox(height: AppSpacing.xs),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: AppButton.text(
                  onPressed: () => setState(() => _showAll = !_showAll),
                  leading: Icon(
                    _showAll ? Icons.expand_less : Icons.expand_more,
                  ),
                  label: _showAll
                      ? 'Show fewer pages'
                      : 'Show all ${all.length} pages',
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }
}

/// The cover as a thumbnail with its report action. It used to be drawn at full
/// width here, a third copy of a cover the hero already shows.
class _CoverRow extends StatelessWidget {
  const _CoverRow({required this.image, required this.onReport});

  final MobileProjectImage image;
  final VoidCallback? onReport;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        SizedBox(
          width: 56,
          child: _AuthenticatedProjectImage(image: image, compact: true),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(
            'Cover art',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        if (onReport != null) _ReportVisualButton(onPressed: onReport!),
      ],
    );
  }
}

class _GeneratedPagePreview extends StatelessWidget {
  const _GeneratedPagePreview({required this.page, this.onReportImage});

  final MobileProjectPage page;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final preview = page.previewText.trim().isNotEmpty
        ? page.previewText
        : page.summary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              'Page ${page.index}',
              style: Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: colors.primary),
            ),
            Text(
              page.title,
              style: Theme.of(
                context,
              ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
          ],
        ),
        if (page.image != null) ...[
          const SizedBox(height: 10),
          _AuthenticatedProjectImage(image: page.image!),
          if (onReportImage != null)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: _ReportVisualButton(
                onPressed: () => onReportImage!(page.image!),
              ),
            ),
        ] else if (page.imageFailed) ...[
          const SizedBox(height: 10),
          const _IllustrationLostNote(),
        ],
        const SizedBox(height: 8),
        Text(preview, maxLines: 6, overflow: TextOverflow.ellipsis),
      ],
    );
  }
}

class _IllustrationLostNote extends StatelessWidget {
  const _IllustrationLostNote();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      children: [
        Icon(
          Icons.image_not_supported_outlined,
          size: 18,
          color: colors.outline,
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            'The illustration for this page could not be generated.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

class _AuthenticatedProjectImage extends StatelessWidget {
  const _AuthenticatedProjectImage({required this.image, this.compact = false});

  final MobileProjectImage image;

  /// A thumbnail: too small for a spinner and a sentence, so both placeholders
  /// are a bare icon.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AspectRatio(
      aspectRatio: image.role == 'cover' ? 3 / 4 : 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(
          compact ? AppRadii.compact - 2 : AppRadii.control,
        ),
        child: AuthedNetworkImage(
          url: image.url,
          cacheBuster: null,
          fit: BoxFit.cover,
          semanticLabel: image.altText,
          loadingPlaceholder: compact
              ? ColoredBox(color: colors.surfaceContainerHighest)
              : _ImageLoading(label: image.altText),
          errorPlaceholder: compact
              ? ColoredBox(
                  color: colors.surfaceContainerHighest,
                  child: Icon(
                    Icons.image_not_supported_outlined,
                    color: colors.outline,
                  ),
                )
              : _ImageUnavailable(label: image.altText),
        ),
      ),
    );
  }
}

class _ImageLoading extends StatelessWidget {
  const _ImageLoading({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.surfaceContainerHighest,
      child: Center(
        child: CircularProgressIndicator(
          semanticsLabel: label.isEmpty
              ? 'Loading generated visual'
              : 'Loading $label',
        ),
      ),
    );
  }
}

class _ImageUnavailable extends StatelessWidget {
  const _ImageUnavailable({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final message = label.isEmpty
        ? 'Generated visual unavailable'
        : '$label unavailable';
    return Semantics(
      label: message,
      child: ExcludeSemantics(
        child: ColoredBox(
          color: colors.surfaceContainerHighest,
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.image_not_supported_outlined,
                    color: colors.outline,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
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

class _ReportVisualButton extends StatelessWidget {
  const _ReportVisualButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return AppButton.text(
      onPressed: onPressed,
      leading: const Icon(Icons.flag_outlined),
      label: 'Report visual',
    );
  }
}

class ContentReportRequest {
  const ContentReportRequest({required this.reason, this.comment});

  final String reason;
  final String? comment;
}

class ContentReportDialog extends StatefulWidget {
  const ContentReportDialog({required this.title, super.key});

  final String title;

  @override
  State<ContentReportDialog> createState() => _ContentReportDialogState();
}

class _ContentReportDialogState extends State<ContentReportDialog> {
  final _commentController = TextEditingController();
  String _reason = 'other';

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DropdownButtonFormField<String>(
            initialValue: _reason,
            decoration: const InputDecoration(labelText: 'Reason'),
            items: const [
              DropdownMenuItem(value: 'offensive', child: Text('Offensive')),
              DropdownMenuItem(
                value: 'hate_or_harassment',
                child: Text('Hate or harassment'),
              ),
              DropdownMenuItem(
                value: 'sexual_content',
                child: Text('Sexual content'),
              ),
              DropdownMenuItem(
                value: 'violence_or_self_harm',
                child: Text('Violence or self-harm'),
              ),
              DropdownMenuItem(
                value: 'child_safety',
                child: Text('Child safety concern'),
              ),
              DropdownMenuItem(
                value: 'deceptive_or_misleading',
                child: Text('Misleading or inaccurate'),
              ),
              DropdownMenuItem(
                value: 'privacy_or_copyright',
                child: Text('Privacy or copyright'),
              ),
              DropdownMenuItem(value: 'other', child: Text('Other')),
            ],
            onChanged: (value) => setState(() => _reason = value ?? 'other'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _commentController,
            decoration: const InputDecoration(
              labelText: 'Optional details',
              hintText: 'Briefly describe the issue',
            ),
            minLines: 3,
            maxLines: 5,
          ),
        ],
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Cancel',
        ),
        AppButton.primary(
          onPressed: () => Navigator.of(context).pop(
            ContentReportRequest(
              reason: _reason,
              comment: _commentController.text.trim().isEmpty
                  ? null
                  : _commentController.text.trim(),
            ),
          ),
          label: 'Send report',
        ),
      ],
    );
  }
}
