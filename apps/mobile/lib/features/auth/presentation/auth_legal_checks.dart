import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show CustomSemanticsAction;

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';

/// The two statements a new account must agree to before it exists: the
/// Terms and Privacy Policy, and the age / guardian attestation.
///
/// Both start unchecked and stay the reader's own act — the server refuses a
/// signup without them, and a pre-ticked box would not be consent. The
/// documents are links inside the sentence they belong to, and they are also
/// offered to screen readers as actions on the row, because a link inside a
/// merged checkbox label cannot be focused on its own.
class AuthLegalAttestations extends StatelessWidget {
  const AuthLegalAttestations({
    required this.termsAccepted,
    required this.ageGuardianAttested,
    required this.onTermsChanged,
    required this.onAgeGuardianChanged,
    required this.onOpenTerms,
    required this.onOpenPrivacy,
    this.showError = false,
    this.enabled = true,
    super.key,
  });

  final bool termsAccepted;
  final bool ageGuardianAttested;
  final ValueChanged<bool> onTermsChanged;
  final ValueChanged<bool> onAgeGuardianChanged;
  final VoidCallback onOpenTerms;
  final VoidCallback onOpenPrivacy;

  /// True once a submit was refused for missing statements; unticked rows then
  /// say so in colour as well as in the sentence beneath.
  final bool showError;
  final bool enabled;

  static const termsLabel =
      'I agree to the Terms and acknowledge the Privacy Policy.';
  static const ageLabel =
      'I confirm that I am at least 13 and, if I am under the age of majority, my parent or guardian has agreed.';
  static const errorMessage = 'Accept both statements to create your account.';

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(
              color: showError && !(termsAccepted && ageGuardianAttested)
                  ? colors.error
                  : colors.outlineVariant,
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.control),
            child: Column(
              children: [
                _CheckRow(
                  checked: termsAccepted,
                  enabled: enabled,
                  flagged: showError && !termsAccepted,
                  semanticLabel: termsLabel,
                  onChanged: onTermsChanged,
                  actions: {
                    'Open Terms': onOpenTerms,
                    'Open Privacy Policy': onOpenPrivacy,
                  },
                  spansBuilder: (link) => [
                    const TextSpan(text: 'I agree to the '),
                    link('Terms', onOpenTerms),
                    const TextSpan(text: ' and acknowledge the '),
                    link('Privacy Policy', onOpenPrivacy),
                    const TextSpan(text: '.'),
                  ],
                ),
                Divider(height: 1, color: colors.outlineVariant),
                _CheckRow(
                  checked: ageGuardianAttested,
                  enabled: enabled,
                  flagged: showError && !ageGuardianAttested,
                  semanticLabel: ageLabel,
                  onChanged: onAgeGuardianChanged,
                  spansBuilder: (link) => const [TextSpan(text: ageLabel)],
                ),
              ],
            ),
          ),
        ),
        if (showError) ...[
          const SizedBox(height: AppSpacing.xs),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: Icon(Icons.error_outline, size: 16, color: colors.error),
              ),
              const SizedBox(width: AppSpacing.xxs),
              Expanded(
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    errorMessage,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: colors.error),
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

typedef _LinkBuilder = InlineSpan Function(String label, VoidCallback onTap);

class _CheckRow extends StatefulWidget {
  const _CheckRow({
    required this.checked,
    required this.enabled,
    required this.flagged,
    required this.semanticLabel,
    required this.onChanged,
    required this.spansBuilder,
    this.actions = const {},
  });

  final bool checked;
  final bool enabled;
  final bool flagged;
  final String semanticLabel;
  final ValueChanged<bool> onChanged;
  final List<InlineSpan> Function(_LinkBuilder link) spansBuilder;
  final Map<String, VoidCallback> actions;

  @override
  State<_CheckRow> createState() => _CheckRowState();
}

class _CheckRowState extends State<_CheckRow> {
  // One recognizer per link, kept for the life of the row: a rebuild in the
  // middle of a press must not dispose the recognizer that is tracking it.
  final Map<String, TapGestureRecognizer> _recognizers = {};

  @override
  void dispose() {
    for (final recognizer in _recognizers.values) {
      recognizer.dispose();
    }
    super.dispose();
  }

  InlineSpan _link(String label, VoidCallback onTap) {
    final recognizer = _recognizers.putIfAbsent(label, TapGestureRecognizer.new)
      ..onTap = onTap;
    return TextSpan(
      text: label,
      recognizer: recognizer,
      style: TextStyle(
        color: Theme.of(context).colorScheme.primary,
        fontWeight: FontWeight.w700,
        decoration: TextDecoration.underline,
      ),
    );
  }

  void _toggle() {
    if (!widget.enabled) return;
    AppHaptics.selection();
    widget.onChanged(!widget.checked);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final spans = widget.spansBuilder(_link);

    return Semantics(
      container: true,
      checked: widget.checked,
      enabled: widget.enabled,
      label: widget.semanticLabel,
      onTap: widget.enabled ? _toggle : null,
      customSemanticsActions: {
        for (final entry in widget.actions.entries)
          CustomSemanticsAction(label: entry.key): entry.value,
      },
      child: ExcludeSemantics(
        child: InkWell(
          onTap: widget.enabled ? _toggle : null,
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(
              AppSpacing.xs,
              AppSpacing.xxs,
              AppSpacing.md,
              AppSpacing.xxs,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Checkbox(
                  value: widget.checked,
                  onChanged: widget.enabled
                      ? (value) => widget.onChanged(value ?? false)
                      : null,
                  side: widget.flagged
                      ? BorderSide(color: colors.error, width: 2)
                      : null,
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: AppSpacing.xs,
                    ),
                    child: Text.rich(
                      TextSpan(children: spans),
                      style: Theme.of(
                        context,
                      ).textTheme.bodyMedium?.copyWith(height: 1.35),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
