import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/data/projects_repository.dart';
import '../data/studio_repository.dart';
import '../domain/manuscript_models.dart';

/// The book's settings: title, subtitle, author, dedication, word goal, art
/// style. Saves through the repository and resolves with the updated
/// manuscript, or null when nothing changed.
///
/// Only what the author actually changed is sent, and a field they emptied is
/// sent as a clear — so two devices editing different settings never undo each
/// other.
Future<Manuscript?> showManuscriptSettingsSheet(
  BuildContext context, {
  required String projectId,
  required Manuscript manuscript,
}) {
  return showAppBottomSheet<Manuscript>(
    context,
    builder: (_) =>
        ManuscriptSettingsSheet(projectId: projectId, manuscript: manuscript),
  );
}

/// The quick word goals: a novella, a novel, a long novel.
const manuscriptGoalPicks = [10000, 50000, 80000];

/// The longest goal the field accepts; anything past it is a typo.
const _maxGoalWords = 2000000;

/// Parses a word goal as typed ("50,000", "50 000", "50000"). Null for an
/// empty field; throws [FormatException] for anything else that is not a
/// positive whole number of words.
int? parseManuscriptGoal(String text) {
  final digits = text.replaceAll(RegExp(r'[\s,._]'), '');
  if (digits.isEmpty) return null;
  final value = int.tryParse(digits);
  if (value == null || value <= 0 || value > _maxGoalWords) {
    throw const FormatException('Not a word goal');
  }
  return value;
}

/// What the author changed, as a partial update, or null when nothing did.
///
/// Text is compared trimmed. An optional field that was set and is now empty
/// becomes a clear; one that was empty and still is sends nothing.
@visibleForTesting
ManuscriptSettingsUpdate? manuscriptSettingsChanges(
  Manuscript original, {
  required String title,
  required String subtitle,
  required String authorName,
  required String dedication,
  required String artStyle,
  required int? goalWords,
}) {
  final clear = <String>{};
  String? changed(String field, String? before, String after) {
    final was = before?.trim() ?? '';
    final now = after.trim();
    if (was == now) return null;
    if (now.isEmpty) {
      clear.add(field);
      return null;
    }
    return now;
  }

  final newTitle = title.trim() == original.title.trim() ? null : title.trim();
  final newSubtitle = changed('subtitle', original.subtitle, subtitle);
  final newAuthor = changed('authorName', original.authorName, authorName);
  final newDedication = changed('dedication', original.dedication, dedication);
  final newArtStyle = changed('artStyle', original.artStyle, artStyle);
  int? newGoal;
  if (goalWords != original.goalWords) {
    if (goalWords == null) {
      clear.add('goalWords');
    } else {
      newGoal = goalWords;
    }
  }
  final update = ManuscriptSettingsUpdate(
    title: newTitle,
    subtitle: newSubtitle,
    authorName: newAuthor,
    dedication: newDedication,
    artStyle: newArtStyle,
    goalWords: newGoal,
    clear: clear,
  );
  return update.toJson().isEmpty ? null : update;
}

@visibleForTesting
class ManuscriptSettingsSheet extends ConsumerStatefulWidget {
  const ManuscriptSettingsSheet({
    required this.projectId,
    required this.manuscript,
    super.key,
  });

  final String projectId;
  final Manuscript manuscript;

  @override
  ConsumerState<ManuscriptSettingsSheet> createState() =>
      _ManuscriptSettingsSheetState();
}

class _ManuscriptSettingsSheetState
    extends ConsumerState<ManuscriptSettingsSheet> {
  late final _title = TextEditingController(text: widget.manuscript.title);
  late final _subtitle = TextEditingController(
    text: widget.manuscript.subtitle ?? '',
  );
  late final _author = TextEditingController(
    text: widget.manuscript.authorName ?? '',
  );
  late final _dedication = TextEditingController(
    text: widget.manuscript.dedication ?? '',
  );
  late final _artStyle = TextEditingController(
    text: widget.manuscript.artStyle ?? '',
  );
  late final _goal = TextEditingController(
    text: widget.manuscript.goalWords?.toString() ?? '',
  );

  bool _saving = false;
  String? _titleError;
  String? _goalError;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _goal.addListener(_onGoalChanged);
  }

  @override
  void dispose() {
    _goal.removeListener(_onGoalChanged);
    for (final controller in [
      _title,
      _subtitle,
      _author,
      _dedication,
      _artStyle,
      _goal,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  /// Redraws the quick picks so the one matching the field stays selected.
  void _onGoalChanged() {
    if (mounted) setState(() => _goalError = null);
  }

  int? get _typedGoal {
    try {
      return parseManuscriptGoal(_goal.text);
    } on FormatException {
      return null;
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    final title = _title.text.trim();
    int? goal;
    String? goalError;
    try {
      goal = parseManuscriptGoal(_goal.text);
    } on FormatException {
      goalError = 'Enter a number of words, like 50,000.';
    }
    // One character is a title: a CJK book is often named in one. The
    // server takes 1–160 everywhere.
    final titleError = title.isEmpty ? 'Give your book a title.' : null;
    if (titleError != null || goalError != null) {
      setState(() {
        _titleError = titleError;
        _goalError = goalError;
      });
      return;
    }
    final update = manuscriptSettingsChanges(
      widget.manuscript,
      title: _title.text,
      subtitle: _subtitle.text,
      authorName: _author.text,
      dedication: _dedication.text,
      artStyle: _artStyle.text,
      goalWords: goal,
    );
    if (update == null) {
      Navigator.of(context).pop();
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _saveError = null;
      _titleError = null;
    });
    try {
      final saved = await ref
          .read(studioRepositoryProvider)
          .updateSettings(widget.projectId, update);
      if (!mounted) return;
      // The title, subtitle and author are written through to the book, so
      // the pages that list it have to hear about it too.
      ref.invalidate(projectsProvider);
      ref.invalidate(projectDetailProvider(widget.projectId));
      ref.invalidate(manuscriptProvider(widget.projectId));
      AppHaptics.success();
      Navigator.of(context).pop(saved);
    } catch (error) {
      if (!mounted) return;
      AppHaptics.error();
      setState(() {
        _saving = false;
        _saveError = userFacingError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final typedGoal = _typedGoal;
    final localizations = MaterialLocalizations.of(context);
    return AppSheetScaffold(
      title: 'Book settings',
      subtitle:
          'How your book presents itself, and the goal you are writing '
          'toward.',
      icon: Icons.tune,
      onClose: _saving ? null : () => Navigator.of(context).pop(),
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_saveError != null) ...[
            AppInlineNotice(
              tone: AppTone.error,
              title: 'Could not save',
              message: _saveError!,
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          AppButton.primary(
            key: const ValueKey('settings-save'),
            label: 'Save',
            loading: _saving,
            loadingLabel: 'Saving',
            expanded: true,
            onPressed: _save,
          ),
        ],
      ),
      children: [
        const SizedBox(height: AppSpacing.xs),
        _field(
          key: 'settings-title',
          controller: _title,
          label: 'Title',
          errorText: _titleError,
          maxLength: 160,
          onChanged: (_) {
            if (_titleError != null) setState(() => _titleError = null);
          },
        ),
        _field(
          key: 'settings-subtitle',
          controller: _subtitle,
          label: 'Subtitle',
          hint: 'Optional',
          maxLength: 200,
        ),
        _field(
          key: 'settings-author',
          controller: _author,
          label: 'Author name',
          hint: 'Your name, or a pen name',
          helper: 'Printed on the cover and the title page.',
          maxLength: 120,
          capitalization: TextCapitalization.words,
        ),
        _field(
          key: 'settings-dedication',
          controller: _dedication,
          label: 'Dedication',
          hint: 'Optional — “For Mum, who read to me.”',
          maxLength: 500,
          maxLines: 3,
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          'Word goal',
          style: theme.textTheme.labelLarge?.copyWith(
            color: colors.onSurfaceVariant,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Wrap(
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xs,
          children: [
            for (final pick in manuscriptGoalPicks)
              ChoiceChip(
                key: ValueKey('settings-goal-$pick'),
                label: Text('${pick ~/ 1000}k'),
                tooltip: '${localizations.formatDecimal(pick)} words',
                selected: typedGoal == pick,
                onSelected: _saving
                    ? null
                    : (_) {
                        AppHaptics.selection();
                        _goal.text = pick.toString();
                      },
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        _field(
          key: 'settings-goal',
          controller: _goal,
          label: 'Words',
          hint: 'Optional — leave empty for no goal',
          helper: 'Shown as a ring on your book page.',
          errorText: _goalError,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9,. ]')),
          ],
          maxLength: 12,
        ),
        _field(
          key: 'settings-art-style',
          controller: _artStyle,
          label: 'Art style',
          hint: 'Optional — “soft watercolour, muted colours”',
          helper: 'Used when you add AI illustrations.',
          maxLength: 300,
        ),
      ],
    );
  }

  Widget _field({
    required String key,
    required TextEditingController controller,
    required String label,
    String? hint,
    String? helper,
    String? errorText,
    int maxLength = 200,
    int maxLines = 1,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    TextCapitalization capitalization = TextCapitalization.sentences,
    ValueChanged<String>? onChanged,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: TextField(
        key: ValueKey(key),
        controller: controller,
        enabled: !_saving,
        maxLength: maxLength,
        maxLengthEnforcement: MaxLengthEnforcement.enforced,
        minLines: 1,
        maxLines: maxLines,
        keyboardType:
            keyboardType ??
            (maxLines > 1 ? TextInputType.multiline : TextInputType.text),
        inputFormatters: inputFormatters,
        textCapitalization: capitalization,
        onChanged: onChanged,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          helperText: helper,
          errorText: errorText,
          counterText: '',
        ),
      ),
    );
  }
}
