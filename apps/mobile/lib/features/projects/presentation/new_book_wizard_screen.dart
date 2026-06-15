import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';

class NewBookWizardScreen extends ConsumerStatefulWidget {
  const NewBookWizardScreen({super.key});

  @override
  ConsumerState<NewBookWizardScreen> createState() =>
      _NewBookWizardScreenState();
}

class _NewBookWizardScreenState extends ConsumerState<NewBookWizardScreen> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _promptController = TextEditingController();

  var _stepIndex = 0;
  var _bookType = 'lead_magnet';
  var _lengthPreset = 'standard';
  var _qualityPreset = 'balanced';
  var _imagesEnabled = true;
  var _isSubmitting = false;

  @override
  void dispose() {
    _titleController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final stepCount = _wizardSteps.length;
    return Scaffold(
      appBar: AppBar(title: const Text('New book')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 120),
          children: [
            LinearProgressIndicator(value: (_stepIndex + 1) / stepCount),
            const SizedBox(height: 18),
            Text(
              _wizardSteps[_stepIndex],
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 16),
            switch (_stepIndex) {
              0 => _BookTypeStep(
                selected: _bookType,
                onChanged: (value) => setState(() => _bookType = value),
              ),
              1 => _PromptStep(
                titleController: _titleController,
                promptController: _promptController,
              ),
              2 => _LengthStep(
                bookType: _bookType,
                selected: _lengthPreset,
                onChanged: (value) => setState(() => _lengthPreset = value),
              ),
              _ => _QualityStep(
                selectedQuality: _qualityPreset,
                imagesEnabled: _imagesEnabled,
                onQualityChanged: (value) =>
                    setState(() => _qualityPreset = value),
                onImagesChanged: (value) =>
                    setState(() => _imagesEnabled = value),
              ),
            },
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 18),
          child: Row(
            children: [
              if (_stepIndex > 0)
                OutlinedButton(
                  onPressed: _isSubmitting
                      ? null
                      : () => setState(() => _stepIndex -= 1),
                  child: const Text('Back'),
                ),
              if (_stepIndex > 0) const SizedBox(width: 12),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _isSubmitting ? null : _nextOrSubmit,
                  icon: _isSubmitting
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          _stepIndex == _wizardSteps.length - 1
                              ? Icons.check
                              : Icons.arrow_forward,
                        ),
                  label: Text(
                    _stepIndex == _wizardSteps.length - 1
                        ? 'Create project'
                        : 'Continue',
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _nextOrSubmit() async {
    if (_stepIndex == 1 && !(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    if (_stepIndex < _wizardSteps.length - 1) {
      setState(() => _stepIndex += 1);
      return;
    }
    if (!(_formKey.currentState?.validate() ?? false)) {
      setState(() => _stepIndex = 1);
      return;
    }

    setState(() => _isSubmitting = true);
    try {
      final project = await ref
          .read(projectsRepositoryProvider)
          .createProject(
            MobileProjectCreateRequest(
              bookType: _bookType,
              title: _titleController.text,
              prompt: _promptController.text,
              lengthPreset: _lengthPreset,
              qualityPreset: _qualityPreset,
              imagesEnabled: _imagesEnabled,
            ),
          );
      ref.invalidate(projectsProvider);
      if (!mounted) {
        return;
      }
      context.pushReplacement('/projects/${project.id}');
    } catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(userFacingError(error))));
    } finally {
      if (mounted) {
        setState(() => _isSubmitting = false);
      }
    }
  }
}

const _wizardSteps = [
  'Choose a book type',
  'Describe the book',
  'Choose a length',
  'Choose the finish',
];

class _BookTypeStep extends StatelessWidget {
  const _BookTypeStep({required this.selected, required this.onChanged});

  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final option in _bookTypeOptions) ...[
          _ChoiceCard(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            subtitle: option.subtitle,
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: 12),
        ],
      ],
    );
  }
}

class _PromptStep extends StatelessWidget {
  const _PromptStep({
    required this.titleController,
    required this.promptController,
  });

  final TextEditingController titleController;
  final TextEditingController promptController;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextFormField(
          controller: titleController,
          decoration: const InputDecoration(
            labelText: 'Working title',
            hintText: 'Leave blank if you want Tomeza to suggest one',
          ),
          textInputAction: TextInputAction.next,
          validator: (value) {
            final text = value?.trim() ?? '';
            if (text.isNotEmpty && text.length < 2) {
              return 'Use at least 2 characters or leave it blank.';
            }
            return null;
          },
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: promptController,
          decoration: const InputDecoration(
            labelText: 'What should this book help with?',
            hintText:
                'Example: Create a 4-week workbook for beginner yoga teachers planning their first paid class.',
            alignLabelWithHint: true,
          ),
          minLines: 6,
          maxLines: 10,
          textInputAction: TextInputAction.newline,
          validator: (value) {
            final text = value?.trim() ?? '';
            if (text.length < 10) {
              return 'Describe the book in at least 10 characters.';
            }
            return null;
          },
        ),
      ],
    );
  }
}

class _LengthStep extends StatelessWidget {
  const _LengthStep({
    required this.bookType,
    required this.selected,
    required this.onChanged,
  });

  final String bookType;
  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final option in _lengthOptions) ...[
          _ChoiceCard(
            selected: selected == option.value,
            icon: option.icon,
            title: option.title,
            subtitle:
                '${_pageCountFor(bookType, option.value)} pages · ${option.subtitle}',
            onTap: () => onChanged(option.value),
          ),
          const SizedBox(height: 12),
        ],
      ],
    );
  }
}

class _QualityStep extends StatelessWidget {
  const _QualityStep({
    required this.selectedQuality,
    required this.imagesEnabled,
    required this.onQualityChanged,
    required this.onImagesChanged,
  });

  final String selectedQuality;
  final bool imagesEnabled;
  final ValueChanged<String> onQualityChanged;
  final ValueChanged<bool> onImagesChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final option in _qualityOptions) ...[
          _ChoiceCard(
            selected: selectedQuality == option.value,
            icon: option.icon,
            title: option.title,
            subtitle: option.subtitle,
            onTap: () => onQualityChanged(option.value),
          ),
          const SizedBox(height: 12),
        ],
        Card(
          child: SwitchListTile(
            value: imagesEnabled,
            onChanged: onImagesChanged,
            secondary: const Icon(Icons.image_outlined),
            title: const Text('Include cover and selected visuals'),
            subtitle: const Text('Best for guides, workbooks, and stories.'),
          ),
        ),
      ],
    );
  }
}

class _ChoiceCard extends StatelessWidget {
  const _ChoiceCard({
    required this.selected,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final bool selected;
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      color: selected ? colors.primaryContainer : null,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Icon(
                icon,
                color: selected ? colors.onPrimaryContainer : colors.primary,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                        color: selected ? colors.onPrimaryContainer : null,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: selected
                            ? colors.onPrimaryContainer
                            : colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Icon(
                selected
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
                color: selected ? colors.onPrimaryContainer : colors.outline,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WizardOption {
  const _WizardOption({
    required this.value,
    required this.title,
    required this.subtitle,
    required this.icon,
  });

  final String value;
  final String title;
  final String subtitle;
  final IconData icon;
}

const _bookTypeOptions = [
  _WizardOption(
    value: 'lead_magnet',
    title: 'Lead magnet ebook',
    subtitle: 'A focused guide for clients, students, or subscribers.',
    icon: Icons.campaign_outlined,
  ),
  _WizardOption(
    value: 'workbook',
    title: 'Workbook or study guide',
    subtitle: 'Lessons, exercises, checklists, and recap sections.',
    icon: Icons.assignment_outlined,
  ),
  _WizardOption(
    value: 'short_story',
    title: 'Short story',
    subtitle: 'A compact fiction project with a clear arc.',
    icon: Icons.auto_stories_outlined,
  ),
];

const _lengthOptions = [
  _WizardOption(
    value: 'short',
    title: 'Short',
    subtitle: 'Lean and quick to review.',
    icon: Icons.short_text,
  ),
  _WizardOption(
    value: 'standard',
    title: 'Standard',
    subtitle: 'A complete first version.',
    icon: Icons.notes_outlined,
  ),
  _WizardOption(
    value: 'expanded',
    title: 'Expanded',
    subtitle: 'More room for examples and exercises.',
    icon: Icons.library_books_outlined,
  ),
];

const _qualityOptions = [
  _WizardOption(
    value: 'fast',
    title: 'Quick draft',
    subtitle: 'Good for testing an idea.',
    icon: Icons.bolt_outlined,
  ),
  _WizardOption(
    value: 'balanced',
    title: 'Balanced',
    subtitle: 'Recommended for most first books.',
    icon: Icons.tune_outlined,
  ),
  _WizardOption(
    value: 'premium',
    title: 'Extra polish',
    subtitle: 'A more careful pass for client-facing books.',
    icon: Icons.workspace_premium_outlined,
  ),
];

int _pageCountFor(String bookType, String lengthPreset) {
  return switch ((bookType, lengthPreset)) {
    ('lead_magnet', 'short') => 12,
    ('lead_magnet', 'standard') => 18,
    ('lead_magnet', 'expanded') => 24,
    ('workbook', 'short') => 16,
    ('workbook', 'standard') => 28,
    ('workbook', 'expanded') => 40,
    ('short_story', 'short') => 8,
    ('short_story', 'standard') => 16,
    ('short_story', 'expanded') => 24,
    (_, _) => 18,
  };
}
