import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../domain/book_matter.dart';

/// A refused profile or book-matter save, in words the author can act on.
///
/// The content screen's 422 names the [fields] that hold the refused words
/// (wire names), so the form can mark them; its message is the server's own
/// sentence. An ISBN without a valid check digit (`INVALID_ISBN`) marks the
/// ISBN field, also with the server's sentence. The two 409s get the app's
/// sentences, because each one has a different fix.
class MatterSaveError {
  const MatterSaveError(
    this.message, {
    this.fields = const {},
    this.unprintable = false,
  });

  final String message;

  /// Wire names (`penName`, `dedication`, `isbn`, …) the server refused.
  final Set<String> fields;

  /// Whether the content screen refused the words in [fields] — as opposed to
  /// a value that is malformed, like an ISBN that fails its check digit.
  final bool unprintable;

  static bool _isRefusal(String code) =>
      code == 'CONTENT_RESTRICTED' || code == 'COPYRIGHT_RESTRICTED';

  static Set<String> _fieldsOf(ApiException error) =>
      (error.details['fields'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toSet();

  factory MatterSaveError.from(Object error) {
    if (error is ApiException) {
      if (_isRefusal(error.code)) {
        final message = error.message.trim();
        return MatterSaveError(
          message.isEmpty
              ? 'Some of this can’t be printed in a book. Change the marked '
                    'fields and save again.'
              : message,
          fields: _fieldsOf(error),
          unprintable: true,
        );
      }
      if (error.code == 'INVALID_ISBN') {
        final message = error.message.trim();
        final fields = _fieldsOf(error);
        return MatterSaveError(
          message.isEmpty
              ? 'That ISBN isn’t valid. Check its digits, or leave the ISBN '
                    'field empty.'
              : message,
          fields: fields.isEmpty ? const {'isbn'} : fields,
        );
      }
      if (error.code == 'PROJECT_BUSY') {
        return const MatterSaveError(
          'This book is being changed right now. Try again once that '
          'finishes.',
        );
      }
      if (error.code == 'SET_IN_STUDIO') {
        return const MatterSaveError(
          'This book’s author name and dedication are set in the Writing '
          'Studio’s book settings.',
        );
      }
    }
    return MatterSaveError(userFacingError(error));
  }

  /// What a refused field says under itself.
  String? errorFor(String field) =>
      fields.contains(field) ? 'Change this to save.' : null;
}

/// The longest start of [text] that fits in [maxLength] UTF-16 code units,
/// cut between characters: never through an emoji or a letter's accents.
String fitUtf16Length(String text, int maxLength) {
  if (text.length <= maxLength) return text;
  var end = 0;
  for (final character in text.characters) {
    if (end + character.length > maxLength) break;
    end += character.length;
  }
  return text.substring(0, end);
}

/// [text] as a field's whole value, cut to [maxLength] UTF-16 code units,
/// with the caret at its end. For text the app fills in itself, which no
/// formatter sees: the account name offered as a pen name is limited in code
/// points, so an emoji in it counts twice against the pen name's limit.
TextEditingValue filledFieldValue(String text, int maxLength) {
  final fitted = fitUtf16Length(text, maxLength);
  return TextEditingValue(
    text: fitted,
    selection: TextSelection.collapsed(offset: fitted.length),
  );
}

/// Holds a field to [maxLength] UTF-16 code units, the unit the server's
/// `z.string().max(n)` counts.
///
/// A text field's own `maxLength` counts grapheme clusters instead, so an
/// emoji was one character in the app and two on the server, and a name the
/// field allowed came back as a bare 400 with no field marked. Like Flutter's
/// enforced limit, a full field ignores more typing and an over-long paste is
/// cut back to what fits. Active IME composition passes through until it
/// commits, when the same limit applies.
class Utf16LengthLimitingTextInputFormatter extends TextInputFormatter {
  const Utf16LengthLimitingTextInputFormatter(this.maxLength);

  final int maxLength;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.composing.isValid && !newValue.composing.isCollapsed) {
      return newValue;
    }
    if (newValue.text.length <= maxLength) return newValue;
    if (oldValue.text.length == maxLength &&
        oldValue.selection.isCollapsed &&
        (!oldValue.composing.isValid || oldValue.composing.isCollapsed)) {
      return oldValue;
    }
    final text = fitUtf16Length(newValue.text, maxLength);
    final selection = newValue.selection;
    return TextEditingValue(
      text: text,
      selection: selection.copyWith(
        baseOffset: math.min(selection.baseOffset, text.length),
        extentOffset: math.min(selection.extentOffset, text.length),
      ),
    );
  }
}

/// The ISBN field's formatter. A leading "ISBN-13:" label comes off as soon
/// as the number starts after it, pasted or typed — the copyright page prints
/// "ISBN" itself — and the limit counts what the server counts: the ISBN
/// without its label. Active composition keeps both label and number intact
/// until it commits.
///
/// Cutting a pasted "ISBN-13: 978-0-306-40615-7" (26 units) to the field's
/// 24 used to leave an ISBN with its last digits gone, which the server then
/// refused as `INVALID_ISBN`.
class IsbnTextInputFormatter extends TextInputFormatter {
  const IsbnTextInputFormatter(this.maxLength);

  final int maxLength;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.composing.isValid && !newValue.composing.isCollapsed) {
      return newValue;
    }
    final cut = typedIsbnLabelLength(newValue.text);
    final value = cut == 0 ? newValue : _withoutLeading(newValue, cut);
    // A label still being typed is not counted, as the server does not
    // count it.
    final label = value.text.length - isbnWithoutLabel(value.text).length;
    return Utf16LengthLimitingTextInputFormatter(
      maxLength + label,
    ).formatEditUpdate(oldValue, value);
  }

  static TextEditingValue _withoutLeading(TextEditingValue value, int cut) {
    int shift(int offset) => offset < 0 ? offset : math.max(0, offset - cut);
    final selection = value.selection;
    return TextEditingValue(
      text: value.text.substring(cut),
      selection: selection.copyWith(
        baseOffset: shift(selection.baseOffset),
        extentOffset: shift(selection.extentOffset),
      ),
    );
  }
}

/// Keeps a matter form's typed words from going with a tap outside the
/// sheet, Back, or the close button: while [hasUnsavedEdits] says so, leaving
/// asks "Discard changes?" first, and "Keep editing" leaves everything as it
/// was. With nothing to lose, leaving just leaves.
///
/// Only a way out that goes through `Navigator.maybePop` is asked about —
/// Back, a sheet's barrier and the app bar's back button do, and a close
/// button should too. A sheet's drag-to-dismiss pops past it, which is why the
/// Title & credits sheet is opened with `enableDrag: false`, as the character
/// editor is.
class MatterLeaveGuard extends StatefulWidget {
  const MatterLeaveGuard({
    required this.edits,
    required this.hasUnsavedEdits,
    required this.message,
    required this.child,
    super.key,
  });

  /// Fires as the form's fields change, so [hasUnsavedEdits] is asked again.
  /// A switch the form flips rebuilds this anyway.
  final Listenable edits;

  /// Whether leaving now would throw typed words away.
  final bool Function() hasUnsavedEdits;

  /// What the question says would be lost.
  final String message;
  final Widget child;

  @override
  State<MatterLeaveGuard> createState() => _MatterLeaveGuardState();
}

class _MatterLeaveGuardState extends State<MatterLeaveGuard> {
  bool _asking = false;

  Future<void> _ask() async {
    if (_asking) return;
    _asking = true;
    final discard = await showAppConfirmationDialog(
      context,
      title: 'Discard changes?',
      message: widget.message,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      destructive: true,
    );
    _asking = false;
    if (!discard || !mounted) return;
    // Only from the top: a form already on its way out, or under something
    // else by now, would pop whatever is on top instead.
    final navigator = Navigator.of(context);
    if (ModalRoute.of(context)?.isCurrent != true || !navigator.canPop()) {
      return;
    }
    navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.edits,
      builder: (context, child) => PopScope<Object?>(
        canPop: !widget.hasUnsavedEdits(),
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _ask();
        },
        child: child!,
      ),
      child: widget.child,
    );
  }
}

/// One text field of a matter form. Long fields show their counter; short
/// ones keep quiet about their limit.
///
/// The limit and the counter are both in UTF-16 code units — see
/// [Utf16LengthLimitingTextInputFormatter] — so the counter reads what the
/// server will count, and a full counter is a field the server takes.
class MatterTextField extends StatelessWidget {
  const MatterTextField({
    required this.fieldKey,
    required this.controller,
    required this.label,
    required this.maxLength,
    this.hint,
    this.helper,
    this.errorText,
    this.maxLines = 1,
    this.minLines = 1,
    this.showCounter = false,
    this.enabled = true,
    this.keyboardType,
    this.capitalization = TextCapitalization.sentences,
    this.autocorrect = true,
    this.onChanged,
    this.inputFormatters,
    super.key,
  });

  final String fieldKey;
  final TextEditingController controller;
  final String label;
  final int maxLength;
  final String? hint;
  final String? helper;
  final String? errorText;
  final int maxLines;
  final int minLines;
  final bool showCounter;
  final bool enabled;
  final TextInputType? keyboardType;
  final TextCapitalization capitalization;
  final bool autocorrect;
  final ValueChanged<String>? onChanged;

  /// In place of the plain [Utf16LengthLimitingTextInputFormatter], for a
  /// field the server counts its own way — the ISBN, whose label it does not
  /// count. Give such a field no [showCounter]: the counter counts the whole
  /// text, label and all, and would say the field is fuller than it is.
  final List<TextInputFormatter>? inputFormatters;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      // A counter is read off the controller, so it follows every keystroke
      // without the form rebuilding around it.
      child: showCounter
          ? ListenableBuilder(
              listenable: controller,
              builder: (context, _) => _field(context),
            )
          : _field(context),
    );
  }

  Widget _field(BuildContext context) {
    final used = controller.text.length;
    return TextField(
      key: ValueKey(fieldKey),
      controller: controller,
      enabled: enabled,
      inputFormatters:
          inputFormatters ??
          [Utf16LengthLimitingTextInputFormatter(maxLength)],
      minLines: minLines,
      maxLines: maxLines,
      keyboardType:
          keyboardType ??
          (maxLines > 1 ? TextInputType.multiline : TextInputType.text),
      textCapitalization: capitalization,
      autocorrect: autocorrect,
      onChanged: onChanged,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        helperText: helper,
        helperMaxLines: 3,
        errorText: errorText,
        errorMaxLines: 3,
        alignLabelWithHint: maxLines > 1,
        counterText: showCounter ? '$used/$maxLength' : '',
        semanticCounterText: showCounter
            ? MaterialLocalizations.of(
                context,
              ).remainingTextFieldCharacterCount(math.max(0, maxLength - used))
            : null,
      ),
    );
  }
}

/// "Use “Mira”" under an empty name field: the account's name, offered and
/// never filled in behind the author's back.
class PenNameSuggestion extends StatelessWidget {
  const PenNameSuggestion({
    required this.suggestion,
    required this.onUse,
    super.key,
  });

  final String suggestion;
  final VoidCallback onUse;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: ActionChip(
          key: const ValueKey('pen-name-suggestion'),
          avatar: const Icon(Icons.person_outline, size: 18),
          label: Text('Use “$suggestion”'),
          tooltip: 'Use your account name as your pen name',
          onPressed: () {
            AppHaptics.selection();
            onUse();
          },
        ),
      ),
    );
  }
}

/// A heading that opens the fields beneath it. Controlled: the form keeps
/// [open], so it can open the section itself when a refusal lands inside.
class MatterDisclosure extends StatelessWidget {
  const MatterDisclosure({
    required this.title,
    required this.open,
    required this.onToggle,
    required this.children,
    this.summary,
    this.toggleKey,
    super.key,
  });

  final String title;

  /// One line under the heading while it is closed: what is set inside.
  final String? summary;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;
  final Key? toggleKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final duration = AppMotion.adapt(context, AppMotion.medium);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          container: true,
          button: true,
          expanded: open,
          label: title,
          onTap: onToggle,
          child: ExcludeSemantics(
            child: InkWell(
              key: toggleKey,
              borderRadius: BorderRadius.circular(AppRadii.compact),
              onTap: () {
                AppHaptics.selection();
                onToggle();
              },
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: theme.textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            if (!open && summary != null) ...[
                              const SizedBox(height: 2),
                              Text(
                                summary!,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      AnimatedRotation(
                        turns: open ? 0.5 : 0,
                        duration: duration,
                        curve: AppMotion.enter,
                        child: Icon(
                          Icons.expand_more,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: duration,
          curve: AppMotion.enter,
          alignment: Alignment.topCenter,
          child: open
              ? Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: children,
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

/// A short line of quiet explanation with a glyph, for what a form does
/// rather than what one field holds.
class MatterNote extends StatelessWidget {
  const MatterNote({
    required this.text,
    this.icon = Icons.info_outline,
    super.key,
  });

  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: ExcludeSemantics(
            child: Icon(icon, size: 16, color: colors.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: AppSpacing.xs),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
              height: 1.35,
            ),
          ),
        ),
      ],
    );
  }
}

/// "Could not save" and why, above a form's save button.
class MatterSaveErrorNotice extends StatelessWidget {
  const MatterSaveErrorNotice({required this.error, super.key});

  final MatterSaveError error;

  @override
  Widget build(BuildContext context) {
    return AppInlineNotice(
      key: const ValueKey('matter-save-error'),
      tone: AppTone.error,
      title: 'Could not save',
      message: error.message,
    );
  }
}
