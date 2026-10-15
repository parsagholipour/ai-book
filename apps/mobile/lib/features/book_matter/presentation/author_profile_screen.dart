import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/book_matter_repository.dart';
import '../domain/author_profile.dart';
import 'matter_form.dart';

/// Where Account → Author profile goes.
const authorProfileLocation = '/account/author-profile';

/// Account → Author profile: the name and the few lines about the author that
/// every new book takes a copy of.
class AuthorProfileScreen extends ConsumerWidget {
  const AuthorProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(authorProfileProvider);
    final profile = value.value;
    final Widget body;
    if (profile != null && !value.hasError) {
      body = AuthorProfileForm(profile: profile);
    } else if (value.hasError) {
      body = AppErrorState(
        title: 'Author profile unavailable',
        message: 'Could not load your author profile.',
        onRetry: () => ref.invalidate(authorProfileProvider),
      );
    } else {
      body = const _ProfileSkeleton();
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Author profile')),
      body: body,
    );
  }
}

/// The form itself, once the profile is here. Its fields start from
/// [profile] and stay the author's own until they save.
@visibleForTesting
class AuthorProfileForm extends ConsumerStatefulWidget {
  const AuthorProfileForm({required this.profile, super.key});

  final AuthorProfile profile;

  @override
  ConsumerState<AuthorProfileForm> createState() => _AuthorProfileFormState();
}

class _AuthorProfileFormState extends ConsumerState<AuthorProfileForm> {
  late final _penName = TextEditingController(
    text: widget.profile.penName ?? '',
  );
  late final _bio = TextEditingController(text: widget.profile.bio ?? '');
  late final _website = TextEditingController(
    text: widget.profile.website ?? '',
  );
  late final _holder = TextEditingController(
    text: widget.profile.copyrightHolder ?? '',
  );
  late final _imprint = TextEditingController(
    text: widget.profile.imprint ?? '',
  );
  late final _edits = Listenable.merge([
    _penName,
    _bio,
    _website,
    _holder,
    _imprint,
  ]);
  late bool _allRightsReserved = widget.profile.allRightsReserved;
  late bool _includeAboutAuthor = widget.profile.includeAboutAuthor;
  bool _publishingOpen = false;
  bool _saving = false;
  MatterSaveError? _error;

  static const _publishingFields = {'copyrightHolder', 'imprint'};

  AuthorProfileUpdate? _changesFrom(AuthorProfile original) =>
      authorProfileChanges(
        original,
        penName: _penName.text,
        bio: _bio.text,
        website: _website.text,
        copyrightHolder: _holder.text,
        imprint: _imprint.text,
        allRightsReserved: _allRightsReserved,
        includeAboutAuthor: _includeAboutAuthor,
      );

  /// Whether leaving would throw typed words away. The setup prompt's answer
  /// is not an edit — every save of a profile that never answered it sends
  /// one — and a save in flight is not either: its words are on their way.
  bool get _hasUnsavedEdits =>
      !_saving &&
      _changesFrom(widget.profile.copyWith(setupPromptSeen: true)) != null;

  @override
  void dispose() {
    for (final controller in [_penName, _bio, _website, _holder, _imprint]) {
      controller.dispose();
    }
    super.dispose();
  }

  String? get _publishingSummary {
    final parts = [
      if (_holder.text.trim().isNotEmpty) '© ${_holder.text.trim()}',
      if (_imprint.text.trim().isNotEmpty) _imprint.text.trim(),
    ];
    return parts.isEmpty ? 'Copyright holder and imprint' : parts.join(' · ');
  }

  Future<void> _save() async {
    if (_saving) return;
    final update = _changesFrom(widget.profile);
    final navigator = Navigator.of(context);
    if (update == null) {
      navigator.maybePop();
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _error = null;
    });
    // The author can go back while this saves, and the save still lands.
    // The screen's state outlives its route by the length of the slide out,
    // so `mounted` alone does not say the screen is still there.
    final messenger = ScaffoldMessenger.of(context);
    final route = ModalRoute.of(context);
    try {
      await ref.read(authorProfileProvider.notifier).save(update);
      AppHaptics.success();
      if (messenger.mounted) {
        messenger.showAppSnackBar(
          const SnackBar(content: Text('Saved. Your next books will use it.')),
        );
      }
      if (!mounted) return;
      // Only from the top: a screen already on its way out would pop the
      // page under it. `pop`, not `maybePop`: the leave guard may not have
      // heard yet that a save is under way, and would ask about discarding
      // what was just saved.
      if (route?.isCurrent == true && navigator.canPop()) {
        navigator.pop();
        return;
      }
      setState(() => _saving = false);
    } catch (error) {
      AppHaptics.error();
      final saveError = MatterSaveError.from(error);
      if (!mounted || route?.isActive == false) {
        // The typed words went with the screen; at least say they did not
        // reach the profile.
        if (messenger.mounted) {
          messenger.showAppSnackBar(
            SnackBar(
              key: const ValueKey('author-profile-not-saved'),
              content: Text(authorProfileNotSavedMessage(saveError)),
            ),
          );
        }
        return;
      }
      setState(() {
        _saving = false;
        _error = saveError;
        if (saveError.fields.any(_publishingFields.contains)) {
          _publishingOpen = true;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return MatterLeaveGuard(
      edits: _edits,
      hasUnsavedEdits: () => _hasUnsavedEdits,
      message: 'Your changes to your author profile haven’t been saved.',
      child: _form(context),
    );
  }

  Widget _form(BuildContext context) {
    final suggestion = widget.profile.penNameSuggestion;
    final error = _error;
    return Column(
      children: [
        Expanded(
          child: AppScreenLayout(
            maxContentWidth: 640,
            children: [
              const SizedBox(height: AppSpacing.xs),
              const MatterNote(
                icon: Icons.auto_stories_outlined,
                text:
                    'These go into each new book you make: your name on the '
                    'title page, and an About the author page at the end. '
                    'Any book can still be changed on its own, from its page.',
              ),
              const SizedBox(height: AppSpacing.lg),
              MatterTextField(
                fieldKey: 'profile-pen-name',
                controller: _penName,
                label: 'Pen name',
                hint: suggestion ?? 'The name on your books',
                helper: 'Printed on the title page: “by …”.',
                errorText: error?.errorFor('penName'),
                maxLength: AuthorProfileLimits.penName,
                capitalization: TextCapitalization.words,
                enabled: !_saving,
                onChanged: (_) => setState(() {}),
              ),
              if (suggestion != null && _penName.text.trim().isEmpty)
                PenNameSuggestion(
                  suggestion: suggestion,
                  onUse: () => setState(() {
                    _penName.value = filledFieldValue(
                      suggestion,
                      AuthorProfileLimits.penName,
                    );
                  }),
                ),
              MatterTextField(
                fieldKey: 'profile-bio',
                controller: _bio,
                label: 'About you',
                hint: 'A few lines for the About the author page.',
                errorText: error?.errorFor('bio'),
                maxLength: AuthorProfileLimits.bio,
                minLines: 4,
                maxLines: 10,
                showCounter: true,
                enabled: !_saving,
              ),
              MatterTextField(
                fieldKey: 'profile-website',
                controller: _website,
                label: 'Website',
                hint: 'yourname.com',
                helper: 'Printed under your bio.',
                errorText: error?.errorFor('website'),
                maxLength: AuthorProfileLimits.website,
                keyboardType: TextInputType.url,
                capitalization: TextCapitalization.none,
                autocorrect: false,
                enabled: !_saving,
              ),
              AppToggleTile(
                key: const ValueKey('profile-include-about'),
                value: _includeAboutAuthor,
                onChanged: _saving
                    ? (_) {}
                    : (value) {
                        AppHaptics.selection();
                        setState(() => _includeAboutAuthor = value);
                      },
                icon: Icons.contact_page_outlined,
                title: 'Add “About the author” to new books',
                subtitle: _includeAboutAuthor
                    ? 'Your bio and website on a page at the end.'
                    : 'New books end without one.',
              ),
              const SizedBox(height: AppSpacing.sm),
              AppToggleTile(
                key: const ValueKey('profile-rights'),
                value: _allRightsReserved,
                onChanged: _saving
                    ? (_) {}
                    : (value) {
                        AppHaptics.selection();
                        setState(() => _allRightsReserved = value);
                      },
                icon: Icons.copyright_outlined,
                title: 'Print “All rights reserved”',
                subtitle: _allRightsReserved
                    ? 'On the copyright page of new books.'
                    : 'New books make no rights statement.',
              ),
              const SizedBox(height: AppSpacing.md),
              MatterDisclosure(
                toggleKey: const ValueKey('profile-publishing-toggle'),
                title: 'Publishing details',
                summary: _publishingSummary,
                open: _publishingOpen,
                onToggle: () =>
                    setState(() => _publishingOpen = !_publishingOpen),
                children: [
                  MatterTextField(
                    fieldKey: 'profile-holder',
                    controller: _holder,
                    label: 'Copyright holder',
                    hint: _penName.text.trim().isEmpty
                        ? 'Your pen name'
                        : _penName.text.trim(),
                    helper: 'Leave empty to use your pen name.',
                    errorText: error?.errorFor('copyrightHolder'),
                    maxLength: AuthorProfileLimits.copyrightHolder,
                    capitalization: TextCapitalization.words,
                    enabled: !_saving,
                    onChanged: (_) => setState(() {}),
                  ),
                  MatterTextField(
                    fieldKey: 'profile-imprint',
                    controller: _imprint,
                    label: 'Imprint or publisher',
                    hint: 'Optional — “Moonlit Press”',
                    errorText: error?.errorFor('imprint'),
                    maxLength: AuthorProfileLimits.imprint,
                    capitalization: TextCapitalization.words,
                    enabled: !_saving,
                    onChanged: (_) => setState(() {}),
                  ),
                ],
              ),
            ],
          ),
        ),
        _SaveBar(error: error, saving: _saving, onSave: _save),
      ],
    );
  }
}

/// What the page underneath says when a save refused after the author had
/// gone back. The marked fields went with the screen, so a refusal says so in
/// words.
String authorProfileNotSavedMessage(MatterSaveError error) {
  final reason = error.unprintable && error.fields.isNotEmpty
      ? 'Some of it can’t be printed in a book.'
      : error.message;
  return 'Your author profile wasn’t saved. $reason';
}

/// The Save button, pinned under the form so it never needs a scroll.
class _SaveBar extends StatelessWidget {
  const _SaveBar({
    required this.error,
    required this.saving,
    required this.onSave,
  });

  final MatterSaveError? error;
  final bool saving;
  final VoidCallback onSave;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          top: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                18,
                AppSpacing.sm,
                18,
                AppSpacing.md,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (error != null) ...[
                    MatterSaveErrorNotice(error: error!),
                    const SizedBox(height: AppSpacing.sm),
                  ],
                  AppButton.primary(
                    key: const ValueKey('profile-save'),
                    label: 'Save',
                    loading: saving,
                    loadingLabel: 'Saving',
                    expanded: true,
                    onPressed: onSave,
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

/// The form's shape while the profile loads: three fields and two switches.
class _ProfileSkeleton extends StatelessWidget {
  const _ProfileSkeleton();

  @override
  Widget build(BuildContext context) {
    return AppScreenLayout(
      maxContentWidth: 640,
      children: [
        AppSkeletonGroup(
          label: 'Loading your author profile',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: const [
              SizedBox(height: AppSpacing.xs),
              AppSkeleton.line(widthFactor: 0.9),
              SizedBox(height: AppSpacing.xs),
              AppSkeleton.line(widthFactor: 0.6),
              SizedBox(height: AppSpacing.lg),
              AppSkeleton.box(height: 56),
              SizedBox(height: AppSpacing.lg),
              AppSkeleton.box(height: 120),
              SizedBox(height: AppSpacing.lg),
              AppSkeleton.box(height: 56),
              SizedBox(height: AppSpacing.lg),
              AppSkeleton.box(height: 72, radius: AppRadii.card),
              SizedBox(height: AppSpacing.sm),
              AppSkeleton.box(height: 72, radius: AppRadii.card),
            ],
          ),
        ),
      ],
    );
  }
}
