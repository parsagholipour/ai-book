import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/app_update_repository.dart';
import '../domain/app_update.dart';

/// How stale the last answer may be before a return to the app asks again.
/// Coming back from a file picker or the share sheet is a resume too.
const _resumeCheckInterval = Duration(minutes: 5);

/// Asks the server about this build at launch and on resume, and shows the
/// "update available" prompt once per release.
///
/// A required update needs nothing here: the router watches the same status
/// and redirects to the update screen itself. The prompt waits for the
/// reader to be on the home screen, so it never lands on someone mid-book.
class AppUpdateWatcher extends ConsumerStatefulWidget {
  const AppUpdateWatcher({
    required this.router,
    required this.child,
    super.key,
  });

  final GoRouter router;
  final Widget child;

  @override
  ConsumerState<AppUpdateWatcher> createState() => _AppUpdateWatcherState();
}

class _AppUpdateWatcherState extends ConsumerState<AppUpdateWatcher> {
  late final AppLifecycleListener _lifecycle;
  bool _prompting = false;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onResume: () => ref
          .read(appUpdateCheckerProvider)
          .refresh(ifOlderThan: _resumeCheckInterval),
    );
    widget.router.routerDelegate.addListener(_maybePrompt);
    Future.microtask(() {
      if (mounted) ref.read(appUpdateCheckerProvider).refresh();
    });
  }

  @override
  void didUpdateWidget(AppUpdateWatcher oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.router != widget.router) {
      oldWidget.router.routerDelegate.removeListener(_maybePrompt);
      widget.router.routerDelegate.addListener(_maybePrompt);
    }
  }

  @override
  void dispose() {
    widget.router.routerDelegate.removeListener(_maybePrompt);
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(appUpdateStatusProvider, (_, _) => _maybePrompt());
    return widget.child;
  }

  bool get _onHome =>
      widget.router.routerDelegate.currentConfiguration.uri.path == '/home';

  Future<void> _maybePrompt() async {
    if (_prompting || !mounted) return;
    final status = ref.read(appUpdateStatusProvider);
    final latestBuild = status.latestBuild;
    if (status.action != AppUpdateAction.prompt || latestBuild == null) return;
    if (!_onHome) return;
    _prompting = true;
    try {
      final store = ref.read(appUpdatePromptStoreProvider);
      final prompted = await store.lastPromptedBuild();
      if (prompted != null && prompted >= latestBuild) return;
      final navigatorContext =
          widget.router.routerDelegate.navigatorKey.currentContext;
      if (!mounted || navigatorContext == null || !_onHome) return;
      // Recorded on show, not on dismissal: "once per release" has to hold
      // even when the app is killed with the sheet open.
      await store.recordPrompted(latestBuild);
      if (!navigatorContext.mounted) return;
      await showAppBottomSheet<void>(
        navigatorContext,
        builder: (_) => AppUpdatePromptSheet(status: status),
      );
    } finally {
      _prompting = false;
    }
  }
}

/// The optional update, offered once. "Update" opens the store listing.
class AppUpdatePromptSheet extends ConsumerWidget {
  const AppUpdatePromptSheet({required this.status, super.key});

  final AppUpdateStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final version = status.latestVersion;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSheetHeader(
          icon: Icons.system_update_outlined,
          title: 'A new version of Tomeza is ready',
          subtitle: version == null ? null : 'Version $version',
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            0,
            AppSpacing.lg,
            AppSpacing.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                status.message ??
                    'Update to get the latest improvements and fixes.',
                style: text.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton.primary(
                onPressed: () async {
                  final navigator = Navigator.of(context);
                  final messenger = ScaffoldMessenger.of(context);
                  final opened = await ref.read(storeListingOpenerProvider)();
                  navigator.pop();
                  if (!opened) {
                    messenger.showAppSnackBar(
                      const SnackBar(
                        content: Text(
                          'Open your app store and search for Tomeza to update.',
                        ),
                      ),
                    );
                  }
                },
                leading: const Icon(Icons.download_outlined),
                label: 'Update',
                expanded: true,
              ),
              const SizedBox(height: AppSpacing.xs),
              AppButton.text(
                onPressed: () => Navigator.of(context).pop(),
                label: 'Not now',
                expanded: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
