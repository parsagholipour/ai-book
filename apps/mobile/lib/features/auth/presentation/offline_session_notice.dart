import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import 'auth_controller.dart';

/// A strip across the top of every screen while the session was opened from
/// this phone alone (`AuthSession.offline`): the reader is in, but nothing
/// that needs the server will work until it answers, and they should know why
/// before the first thing they tap fails. It goes away by itself once
/// `AuthController` reaches the server again.
class OfflineSessionNotice extends ConsumerWidget {
  const OfflineSessionNotice({required this.child, super.key});

  final Widget child;

  static const message =
      'Offline — showing what is on this phone. Reconnecting…';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offline = ref.watch(
      authControllerProvider.select(
        (state) => state.asData?.value?.offline ?? false,
      ),
    );
    if (!offline) return child;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final media = MediaQuery.of(context);
    return Column(
      children: [
        Material(
          key: const ValueKey('offline-session-notice'),
          color: colors.inverseSurface,
          child: Semantics(
            container: true,
            liveRegion: true,
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                AppSpacing.md,
                media.padding.top + AppSpacing.xs,
                AppSpacing.md,
                AppSpacing.xs,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.cloud_off_outlined,
                    size: 18,
                    color: colors.onInverseSurface,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      message,
                      style: text.bodySmall?.copyWith(
                        color: colors.onInverseSurface,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        // The strip has taken the status bar's inset; the screen below must
        // not leave room for it a second time.
        Expanded(
          child: MediaQuery(
            data: media.removePadding(removeTop: true),
            child: child,
          ),
        ),
      ],
    );
  }
}
