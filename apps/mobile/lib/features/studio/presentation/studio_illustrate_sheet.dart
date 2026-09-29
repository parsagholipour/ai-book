import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/assist_models.dart';
import '../domain/assist_text.dart';
import 'studio_ai_billing.dart';
import 'studio_ai_widgets.dart';

/// Illustrate: what the picture should show — prefilled from the passage,
/// the author's to change — the style it is drawn in, and the price on the
/// one button that starts it. Resolves with the started request, or null.
Future<ManuscriptAssist?> showStudioIllustrateSheet(
  BuildContext context, {
  required String projectId,
  required String prompt,
  required String? artStyle,
  required Future<String?> Function() onChangeStyle,
  required Future<ManuscriptAssist> Function(String prompt) start,
}) {
  return showAppBottomSheet<ManuscriptAssist>(
    context,
    builder: (_) => _IllustrateSheet(
      projectId: projectId,
      prompt: prompt,
      artStyle: artStyle,
      onChangeStyle: onChangeStyle,
      start: start,
    ),
  );
}

class _IllustrateSheet extends ConsumerStatefulWidget {
  const _IllustrateSheet({
    required this.projectId,
    required this.prompt,
    required this.artStyle,
    required this.onChangeStyle,
    required this.start,
  });

  final String projectId;
  final String prompt;
  final String? artStyle;
  final Future<String?> Function() onChangeStyle;
  final Future<ManuscriptAssist> Function(String prompt) start;

  @override
  ConsumerState<_IllustrateSheet> createState() => _IllustrateSheetState();
}

class _IllustrateSheetState extends ConsumerState<_IllustrateSheet> {
  late final _prompt = TextEditingController(
    text: clipHead(widget.prompt, illustratePromptChars),
  );
  late String? _style = widget.artStyle;

  @override
  void initState() {
    super.initState();
    _prompt.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _changeStyle() async {
    final style = await widget.onChangeStyle();
    if (mounted) setState(() => _style = style);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final style = _style?.trim();
    final price = watchStudioAssistPrice(
      ref,
      widget.projectId,
      LongAssistKind.illustrate,
    );
    return AppSheetScaffold(
      title: 'Illustrate',
      subtitle:
          'Say what the picture shows. It’s drawn while you keep writing.',
      icon: Icons.image_outlined,
      onClose: () => Navigator.of(context).pop(),
      footer: StudioPaidButton<ManuscriptAssist>(
        projectId: widget.projectId,
        label: 'Create picture',
        credits: price,
        enabled: _prompt.text.trim().isNotEmpty,
        reason: 'Drawing a picture for your book.',
        start: () => widget.start(_prompt.text.trim()),
        onStarted: (assist) => Navigator.of(context).pop(assist),
      ),
      children: [
        TextField(
          key: const ValueKey('studio-illustrate-prompt'),
          controller: _prompt,
          minLines: 3,
          maxLines: 8,
          maxLength: illustratePromptChars,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(
            labelText: 'What the picture shows',
            alignLabelWithHint: true,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Material(
          color: colors.surfaceContainerLow,
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: InkWell(
            key: const ValueKey('studio-illustrate-style'),
            borderRadius: BorderRadius.circular(AppRadii.control),
            onTap: _changeStyle,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.sm,
                vertical: AppSpacing.sm,
              ),
              child: Row(
                children: [
                  Icon(Icons.palette_outlined, color: colors.primary),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: 'Style  ',
                            style: TextStyle(
                              color: colors.onSurfaceVariant,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          TextSpan(
                            text: style == null || style.isEmpty
                                ? 'Your book’s default style'
                                : style,
                          ),
                        ],
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                  Text(
                    'Change',
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: colors.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          'The book’s characters keep their looks. A placeholder marks the '
          'spot, and the picture takes its place when it’s ready.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// "Illustrate every page": how many pages get a picture, what one costs and
/// what they come to. Resolves true when the author confirms.
Future<bool> showStudioIllustrateAllSheet(
  BuildContext context, {
  required String projectId,
  required int pages,
  required int skipped,
}) async {
  final confirmed = await showAppBottomSheet<bool>(
    context,
    builder: (_) => _IllustrateAllSheet(
      projectId: projectId,
      pages: pages,
      skipped: skipped,
    ),
  );
  return confirmed ?? false;
}

class _IllustrateAllSheet extends ConsumerWidget {
  const _IllustrateAllSheet({
    required this.projectId,
    required this.pages,
    required this.skipped,
  });

  final String projectId;
  final int pages;
  final int skipped;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final each = watchStudioAssistPrice(
      ref,
      projectId,
      LongAssistKind.illustrate,
    );
    final total = each == null ? null : each * pages;
    final failed = each == null && watchStudioPriceFailed(ref, projectId);
    final pagesLabel = pages == 1 ? '1 page' : '$pages pages';
    return AppSheetScaffold(
      title: 'Illustrate every page',
      subtitle:
          'A picture for each page that doesn’t have one, drawn from that '
          'page’s words.',
      icon: Icons.collections_outlined,
      onClose: () => Navigator.of(context).pop(false),
      footer: failed
          ? AppButton.outlined(
              label: 'Try loading the price again',
              expanded: true,
              onPressed: () => retryStudioPrice(ref, projectId),
            )
          : AppButton.primary(
              key: const ValueKey('studio-illustrate-all-confirm'),
              label: total == null
                  ? 'Checking the price…'
                  : 'Illustrate $pagesLabel · ${studioCredits(total)}',
              expanded: true,
              onPressed: total == null
                  ? null
                  : () => Navigator.of(context).pop(true),
            ),
      children: [
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              children: [
                _PriceRow(label: 'Pages without a picture', value: '$pages'),
                const SizedBox(height: AppSpacing.xs),
                _PriceRow(
                  label: 'Each picture',
                  value: each == null ? '…' : studioCredits(each),
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: AppSpacing.xs),
                  child: Divider(height: 1),
                ),
                _PriceRow(
                  label: 'Total',
                  value: total == null ? '…' : studioCredits(total),
                  strong: true,
                ),
              ],
            ),
          ),
        ),
        if (skipped > 0) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(
            skipped == 1
                ? '1 page has no words yet, so it’s left out.'
                : '$skipped pages have no words yet, so they’re left out.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.sm),
        Text(
          'Each page shows its picture being drawn. A picture that can’t be '
          'drawn is not charged.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _PriceRow extends StatelessWidget {
  const _PriceRow({
    required this.label,
    required this.value,
    this.strong = false,
  });

  final String label;
  final String value;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = strong
        ? theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)
        : theme.textTheme.bodyMedium;
    return Row(
      children: [
        Expanded(child: Text(label, style: style)),
        Text(
          value,
          style: style?.copyWith(
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }
}
