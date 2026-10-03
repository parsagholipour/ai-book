import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../auth/domain/auth_models.dart';
import '../../auth/presentation/auth_controller.dart';
import '../data/push_device_repository.dart';
import '../data/push_messaging.dart';

/// Offered once, right after a reader starts writing a book: the moment the
/// notification is obviously worth having. Android 13+ asks for the
/// permission only once anyway, so this explains it before the system does —
/// the same order the microphone prompt uses. Readers who are already
/// allowed, or were already asked, see nothing.
Future<void> offerBookNotifications(BuildContext context, WidgetRef ref) async {
  final messaging = ref.read(pushMessagingProvider);
  if (messaging == null) return;
  if (await messaging.permission() != PushPermission.notAsked) return;
  if (await messaging.wasOffered() || !context.mounted) return;
  // Recorded on show, not on the answer, like the update prompt: "once" has
  // to hold even when the app is closed with the sheet open. "Not now" is an
  // answer too; the Account screen's row is where to change it.
  await messaging.markOffered();
  if (!context.mounted) return;
  final accepted = await showAppBottomSheet<bool>(
    context,
    builder: (_) => const _BookNotificationsOfferSheet(),
  );
  if (accepted == true) await enableBookNotifications(ref);
}

/// Asks the system, then files this install with the server if it said yes.
Future<PushPermission?> enableBookNotifications(WidgetRef ref) async {
  final messaging = ref.read(pushMessagingProvider);
  if (messaging == null) return null;
  final permission = await messaging.requestPermission();
  ref.invalidate(pushPermissionProvider);
  // Awaited rather than read: a session still restoring is still a session.
  final session = await ref
      .read(authControllerProvider.future)
      .then<AuthSession?>((session) => session, onError: (_) => null);
  await ref.read(pushRegistrarProvider)?.sync(userId: session?.user.id);
  return permission;
}

class _BookNotificationsOfferSheet extends StatelessWidget {
  const _BookNotificationsOfferSheet();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const AppSheetHeader(
          icon: Icons.notifications_active_outlined,
          title: 'Know when your book is ready',
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
                'Tomeza can show your book’s progress while it is being '
                'written and tell you the moment it is ready, even after you '
                'close the app.',
                style: text.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton.primary(
                onPressed: () => Navigator.of(context).pop(true),
                leading: const Icon(Icons.notifications_outlined),
                label: 'Turn on notifications',
                expanded: true,
              ),
              const SizedBox(height: AppSpacing.xs),
              AppButton.text(
                onPressed: () => Navigator.of(context).pop(false),
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

/// The Account screen's row: what notifications are set to, and the one
/// place to change it. Hidden when this build cannot send them.
class BookNotificationsSettingsRow extends ConsumerWidget {
  const BookNotificationsSettingsRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(pushMessagingProvider) == null) {
      return const SizedBox.shrink();
    }
    final permission = ref.watch(pushPermissionProvider).asData?.value;
    return AppSettingsRow(
      key: const ValueKey('account-notifications'),
      icon: Icons.notifications_outlined,
      title: 'Notifications',
      subtitle: 'Book progress, and when a book is ready',
      value: switch (permission) {
        PushPermission.granted => 'On',
        PushPermission.denied || PushPermission.notAsked => 'Off',
        null => null,
      },
      onTap: () async {
        if (permission == PushPermission.notAsked) {
          await enableBookNotifications(ref);
          return;
        }
        // Once asked, Android will not show its prompt again; on or off,
        // the phone's settings page is where it changes.
        await ref.read(pushMessagingProvider)?.openSettings();
      },
    );
  }
}
