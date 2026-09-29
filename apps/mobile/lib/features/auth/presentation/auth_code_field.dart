import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';

/// The digits of a one-time code that is sitting on the clipboard, or null.
///
/// Mail apps copy "Your code is 123 456" as often as "123456", so anything
/// that reduces to exactly [length] digits — or contains one standalone run of
/// that many — counts. A number that merely contains digits does not.
String? codeFromClipboardText(String? text, {int length = 6}) {
  if (text == null) return null;
  final digitsOnly = text.replaceAll(RegExp(r'\D'), '');
  if (digitsOnly.length == length) return digitsOnly;
  final run = RegExp('(?<!\\d)\\d{$length}(?!\\d)').firstMatch(text);
  return run?.group(0);
}

/// A one-time code drawn as separate boxes over one real text field.
///
/// The field underneath is what the keyboard, autofill (`oneTimeCode`) and the
/// platform paste menu talk to, so a code arriving from the messages app or the
/// clipboard fills every box at once; the boxes only mirror its text. It is a
/// [TextFormField] on purpose — anything that finds the form's fields by type
/// still reaches it.
///
/// Validation shows beneath the boxes, in the same words the form uses
/// elsewhere, and is driven by the parent through [autovalidate].
class AuthCodeField extends StatefulWidget {
  const AuthCodeField({
    required this.controller,
    required this.focusNode,
    required this.errorMessage,
    this.length = 6,
    this.enabled = true,
    this.autovalidate = false,
    this.onCompleted,
    this.onChanged,
    this.semanticLabel = 'Six-digit code',
    super.key,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final int length;
  final bool enabled;

  /// What the field says when the code is incomplete.
  final String errorMessage;
  final bool autovalidate;

  /// Called once each time the last box is filled.
  final VoidCallback? onCompleted;
  final ValueChanged<String>? onChanged;
  final String semanticLabel;

  @override
  State<AuthCodeField> createState() => _AuthCodeFieldState();
}

class _AuthCodeFieldState extends State<AuthCodeField> {
  static const double _boxHeight = 56;

  final _fieldKey = GlobalKey<FormFieldState<String>>();
  bool _wasComplete = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
    _wasComplete = widget.controller.text.length == widget.length;
  }

  @override
  void didUpdateWidget(AuthCodeField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    super.dispose();
  }

  void _onText() {
    final text = widget.controller.text;
    _fieldKey.currentState?.didChange(text);
    widget.onChanged?.call(text);
    final complete = text.length == widget.length;
    if (complete && !_wasComplete) {
      widget.onCompleted?.call();
    }
    _wasComplete = complete;
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return FormField<String>(
      key: _fieldKey,
      initialValue: widget.controller.text,
      autovalidateMode: widget.autovalidate
          ? AutovalidateMode.onUserInteraction
          : AutovalidateMode.disabled,
      validator: (value) =>
          (value?.length ?? 0) == widget.length ? null : widget.errorMessage,
      builder: (state) {
        final hasError = state.hasError;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: _boxHeight,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: ExcludeSemantics(
                      child: ListenableBuilder(
                        listenable: Listenable.merge([
                          widget.controller,
                          widget.focusNode,
                        ]),
                        builder: (context, _) => _Boxes(
                          value: widget.controller.text,
                          length: widget.length,
                          focused: widget.focusNode.hasFocus,
                          enabled: widget.enabled,
                          hasError: hasError,
                        ),
                      ),
                    ),
                  ),
                  // The digits are drawn by the boxes; this field only has to
                  // hear the keyboard, autofill and paste. Its own text is
                  // invisible and never scaled, so a large text size cannot
                  // grow it past the boxes it sits on.
                  Positioned.fill(
                    child: MediaQuery(
                      data: MediaQuery.of(
                        context,
                      ).copyWith(textScaler: TextScaler.noScaling),
                      child: Semantics(
                        label: widget.semanticLabel,
                        child: TextFormField(
                          controller: widget.controller,
                          focusNode: widget.focusNode,
                          enabled: widget.enabled,
                          keyboardType: TextInputType.number,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.oneTimeCode],
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                            LengthLimitingTextInputFormatter(widget.length),
                          ],
                          showCursor: false,
                          cursorColor: Colors.transparent,
                          enableSuggestions: false,
                          autocorrect: false,
                          style: const TextStyle(color: Colors.transparent),
                          decoration: const InputDecoration(
                            filled: false,
                            isCollapsed: true,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            disabledBorder: InputBorder.none,
                            errorBorder: InputBorder.none,
                            focusedErrorBorder: InputBorder.none,
                            counterText: '',
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (hasError) ...[
              const SizedBox(height: AppSpacing.xs),
              Semantics(
                liveRegion: true,
                child: Text(
                  state.errorText ?? '',
                  style: text.bodySmall?.copyWith(color: colors.error),
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

class _Boxes extends StatelessWidget {
  const _Boxes({
    required this.value,
    required this.length,
    required this.focused,
    required this.enabled,
    required this.hasError,
  });

  final String value;
  final int length;
  final bool focused;
  final bool enabled;
  final bool hasError;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final digitStyle = Theme.of(context).textTheme.titleLarge?.copyWith(
      fontWeight: FontWeight.w800,
      fontFeatures: const [FontFeature.tabularFigures()],
      color: enabled ? colors.onSurface : colors.onSurfaceVariant,
    );
    // The digit is one glyph in a fixed-height box; past 1.3x it would only
    // crowd the border, so it stops growing there.
    final scaler = MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3);
    final active = value.length.clamp(0, length - 1);

    return Row(
      children: [
        for (var i = 0; i < length; i++) ...[
          if (i > 0) const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: enabled
                    ? colors.surfaceContainerLowest
                    : colors.surfaceContainerLow,
                borderRadius: BorderRadius.circular(AppRadii.control),
                border: Border.all(
                  color: hasError
                      ? colors.error
                      : focused && i == active
                      ? colors.primary
                      : colors.outlineVariant,
                  width: focused && i == active || hasError ? 1.6 : 1,
                ),
              ),
              child: Text(
                i < value.length ? value[i] : '',
                textScaler: scaler,
                style: digitStyle,
              ),
            ),
          ),
        ],
      ],
    );
  }
}
