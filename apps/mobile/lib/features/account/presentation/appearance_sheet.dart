import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../data/appearance_store.dart';
import '../domain/appearance_prefs.dart';

Future<void> showAppearanceSheet(BuildContext context) {
  return showAppBottomSheet<void>(
    context,
    builder: (_) => const AppearanceSheet(),
  );
}

class AppearanceSheet extends ConsumerWidget {
  const AppearanceSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected =
        ref.watch(appearanceModeProvider).value ?? AppearanceMode.system;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.sm,
        AppSpacing.lg,
        AppSpacing.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Appearance',
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: AppSpacing.md),
          for (final mode in AppearanceMode.values) ...[
            AppChoiceTile(
              selected: selected == mode,
              icon: _iconFor(mode),
              title: mode.label,
              onTap: () async {
                await ref.read(appearanceModeProvider.notifier).setMode(mode);
                if (context.mounted) {
                  Navigator.of(context).pop();
                }
              },
            ),
            if (mode != AppearanceMode.dark)
              const SizedBox(height: AppSpacing.xs),
          ],
        ],
      ),
    );
  }
}

IconData _iconFor(AppearanceMode mode) => switch (mode) {
  AppearanceMode.system => Icons.brightness_auto_outlined,
  AppearanceMode.light => Icons.light_mode_outlined,
  AppearanceMode.dark => Icons.dark_mode_outlined,
};
