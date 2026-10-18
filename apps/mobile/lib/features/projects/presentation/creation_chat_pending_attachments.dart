part of 'creation_chat_screen.dart';

// The files sitting above the composer, waiting to go out with the next message:
// what each one is, whether it has been read yet, and a way to take it back.
// Upload state and retries stay with CreationChatController. Imports and shared
// state live in the parent library file.

class _PendingAttachmentsRow extends StatelessWidget {
  const _PendingAttachmentsRow({
    required this.attachments,
    required this.onRetry,
    required this.onRemove,
  });

  final List<PendingCreationAttachment> attachments;
  final ValueChanged<String> onRetry;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      // Tall enough for the chip at large text: the name and its status stack.
      height: 60 * MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.4),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final attachment = attachments[index];
          return _PendingAttachmentChip(
            attachment: attachment,
            onRetry: () => onRetry(attachment.localId),
            onRemove: () => onRemove(attachment.localId),
          );
        },
      ),
    );
  }
}

class _PendingAttachmentChip extends ConsumerWidget {
  const _PendingAttachmentChip({
    required this.attachment,
    required this.onRetry,
    required this.onRemove,
  });

  final PendingCreationAttachment attachment;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final theme = Theme.of(context).textTheme;
    final failedDetail = attachment.error?.trim();
    final statusLabel = attachment.isUploading
        ? 'Reading…'
        : attachment.isFailed
        ? (failedDetail == null || failedDetail.isEmpty
              ? 'Failed — tap to retry'
              : failedDetail)
        : attachment.attachment?.pages != null
        ? '${attachment.attachment!.pages} pages read'
        : 'Ready to send';
    final statusColor = attachment.isFailed
        ? colors.onErrorContainer
        : attachment.isReady
        ? colors.primary
        : colors.onSurfaceVariant;
    return Semantics(
      label: 'Attachment ${attachment.name}, $statusLabel',
      child: Material(
        color: attachment.isFailed
            ? colors.errorContainer
            : colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.control),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: attachment.isFailed
              ? onRetry
              : attachment.isReady
              ? () => unawaited(_previewOrOpen(context, ref))
              : null,
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(8, 6, 2, 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _leading(colors, ref),
                const SizedBox(width: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 140),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        attachment.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.labelMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        statusLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.labelSmall?.copyWith(
                          color: statusColor,
                          fontWeight: attachment.isReady
                              ? FontWeight.w600
                              : null,
                        ),
                      ),
                    ],
                  ),
                ),
                // A real 40dp target: the old 16dp cross was easy to miss and
                // easier to hit by accident when reaching for the chip itself.
                IconButton(
                  tooltip: 'Remove ${attachment.name}',
                  onPressed: onRemove,
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints.tightFor(
                    width: 40,
                    height: 40,
                  ),
                  padding: EdgeInsets.zero,
                  icon: Icon(
                    Icons.close,
                    size: 18,
                    color: attachment.isFailed
                        ? colors.onErrorContainer
                        : colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _previewOrOpen(BuildContext context, WidgetRef ref) async {
    final localPath = attachment.localPath;
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto) {
      final resolved = resolveChatAssetUri(ref: ref, remoteUrl: remoteUrl);
      await showChatImagePreview(
        context: context,
        localPath: localPath,
        remoteUrl: resolved?.uri,
        headers: resolved?.headers,
        semanticLabel: attachment.name,
      );
      return;
    }
    await openChatAttachment(
      context: context,
      ref: ref,
      name: attachment.name,
      localPath: localPath,
      remoteUrl: remoteUrl,
      mimeType: attachment.mimeType,
    );
  }

  /// The 40dp tile at the chip's start: the picture itself for a photo, a file
  /// glyph otherwise, with the state drawn over it — a spinner while it is being
  /// read, a retry arrow when reading failed.
  Widget _leading(ColorScheme colors, WidgetRef ref) {
    const size = 40.0;
    final radius = BorderRadius.circular(AppRadii.compact);
    Widget tile(Widget child, {Color? color}) => ClipRRect(
      borderRadius: radius,
      child: SizedBox.square(
        dimension: size,
        child: ColoredBox(
          color: color ?? colors.primaryContainer,
          child: child,
        ),
      ),
    );
    final glyph = attachment.isPhoto
        ? Icons.photo_outlined
        : Icons.description_outlined;
    if (attachment.isFailed) {
      return tile(
        Icon(Icons.refresh, size: 22, color: colors.onErrorContainer),
        color: colors.onErrorContainer.withValues(alpha: 0.12),
      );
    }
    Widget picture = Icon(glyph, size: 22, color: colors.onPrimaryContainer);
    final localPath = attachment.localPath;
    final remoteUrl = attachment.attachment?.url;
    if (attachment.isPhoto &&
        localPath != null &&
        appFile(localPath).existsSync()) {
      picture = Image(
        image: localFileImage(localPath),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) =>
            Icon(glyph, size: 22, color: colors.onPrimaryContainer),
      );
    } else if (attachment.isPhoto && remoteUrl != null) {
      picture = AuthedNetworkImage(
        url: remoteUrl,
        cacheBuster: null,
        width: size,
        height: size,
        fit: BoxFit.cover,
        logicalDecodeWidth: 40,
        loadingPlaceholder: Icon(glyph, size: 22),
        errorPlaceholder: Icon(glyph, size: 22),
      );
    }
    if (!attachment.isUploading) return tile(Center(child: picture));
    return tile(
      Stack(
        alignment: Alignment.center,
        fit: StackFit.expand,
        children: [
          Center(child: picture),
          ColoredBox(color: colors.scrim.withValues(alpha: 0.28)),
          Center(
            child: SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2.4,
                color: colors.onPrimaryContainer,
                backgroundColor: colors.onPrimaryContainer.withValues(
                  alpha: 0.25,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
