import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

// What has actually been written so far — pages and visuals as they land —
// plus the reporting affordances that have to sit beside AI-generated content.

class GeneratedBookPreview extends StatelessWidget {
  const GeneratedBookPreview({
    required this.project,
    this.onReportProject,
    this.onReportImage,
    super.key,
  });

  final MobileProjectDetail project;
  final Future<void> Function()? onReportProject;
  final Future<void> Function(MobileProjectImage image)? onReportImage;

  @override
  Widget build(BuildContext context) {
    final pages = project.pages
        .where(
          (page) =>
              page.previewText.trim().isNotEmpty || page.summary.isNotEmpty,
        )
        .toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Book preview',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            Text(
              'AI-generated content from your prompt and selected preset.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            if (onReportProject != null) ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: () => onReportProject!(),
                icon: const Icon(Icons.flag_outlined),
                label: const Text('Report book'),
              ),
            ],
            const SizedBox(height: 12),
            if (project.coverImage != null) ...[
              _AuthenticatedProjectImage(image: project.coverImage!),
              if (onReportImage != null) ...[
                const SizedBox(height: 8),
                _ReportVisualButton(
                  onPressed: () => onReportImage!(project.coverImage!),
                ),
              ],
              const SizedBox(height: 12),
            ],
            if (pages.isEmpty)
              Text(
                'Generated pages will appear here as soon as writing starts.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              )
            else
              for (final page in pages) ...[
                _GeneratedPagePreview(page: page, onReportImage: onReportImage),
                if (page != pages.last) const Divider(height: 22),
              ],
          ],
        ),
      ),
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
          if (onReportImage != null) ...[
            const SizedBox(height: 8),
            _ReportVisualButton(onPressed: () => onReportImage!(page.image!)),
          ],
        ] else if (page.imageFailed) ...[
          const SizedBox(height: 10),
          const _IllustrationLostNote(),
        ],
        const SizedBox(height: 8),
        Text(preview, maxLines: 8, overflow: TextOverflow.ellipsis),
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
        Icon(Icons.image_not_supported_outlined, size: 18, color: colors.outline),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            'The illustration for this page could not be generated.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

class _AuthenticatedProjectImage extends ConsumerWidget {
  const _AuthenticatedProjectImage({required this.image});

  final MobileProjectImage image;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final headersValue = ref.watch(projectAssetHeadersProvider);
    final config = ref.watch(appConfigProvider);
    final uri = config.apiBaseUrl.resolve(image.url).toString();
    return AspectRatio(
      aspectRatio: image.role == 'cover' ? 3 / 4 : 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: headersValue.when(
          data: (headers) => Image.network(
            uri,
            headers: headers,
            fit: BoxFit.cover,
            semanticLabel: image.altText,
            errorBuilder: (context, error, stackTrace) =>
                _ImageUnavailable(label: image.altText),
          ),
          loading: () => _ImageLoading(label: image.altText),
          error: (error, stackTrace) => _ImageUnavailable(label: image.altText),
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

  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton.icon(
        onPressed: () => onPressed(),
        icon: const Icon(Icons.flag_outlined),
        label: const Text('Report visual'),
      ),
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
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(
            ContentReportRequest(
              reason: _reason,
              comment: _commentController.text.trim().isEmpty
                  ? null
                  : _commentController.text.trim(),
            ),
          ),
          child: const Text('Send report'),
        ),
      ],
    );
  }
}
