import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../data/billing_repository.dart';
import '../data/message_allowance_repository.dart';
import '../domain/message_allowance.dart';
import 'billing_paywall.dart';

final _checkingAllowance = Expando<bool>();

/// Used before clearing a composer. A stale server-side refusal uses the same sheet.
Future<bool> ensureMessageAllowance(BuildContext context, WidgetRef ref) async {
  // Refreshing may take a network round trip. A second tap must not submit the
  // same composer while the first tap is still checking its allowance.
  if (_checkingAllowance[context] == true) return false;
  _checkingAllowance[context] = true;
  try {
    return await _checkMessageAllowance(context, ref);
  } finally {
    _checkingAllowance[context] = false;
  }
}

Future<bool> _checkMessageAllowance(BuildContext context, WidgetRef ref) async {
  final billing = ref.read(billingProvider).asData?.value;
  final allowance = billing?.messageAllowance;
  if (allowance == null || !allowance.resetsAt.isAfter(DateTime.now())) {
    return true; // The server is authoritative; never block on stale local data.
  }
  if (!allowance.isExhausted &&
      billing!.credits.available >= allowance.creditsPerMessage) {
    return true;
  }
  // A second device or an admin may have restored the allowance while this
  // screen kept the provider alive. Refresh before making a local refusal.
  try {
    final latest = await ref.refresh(billingProvider.future);
    if (!context.mounted) return false;
    final current = latest.messageAllowance;
    if (current == null ||
        !current.resetsAt.isAfter(DateTime.now()) ||
        (!current.isExhausted &&
            latest.credits.available >= current.creditsPerMessage)) {
      return true;
    }
    if (!current.isExhausted) {
      await showBillingPaywall(
        context,
        creditsNeeded: PaywallCreditsNeeded(
          credits: current.creditsPerMessage,
          reason: 'Sending this message.',
        ),
      );
      return false;
    }
  } catch (_) {
    // Let the actual send report any connectivity failure; cached data cannot
    // authoritatively say that the account is still out of messages.
    return context.mounted;
  }
  if (!context.mounted) return false;
  await showMessageAllowance(context, refresh: false);
  return false;
}

Future<void> handleMessageAllowanceError(
  BuildContext context,
  WidgetRef ref,
  Object error,
) async {
  ref.invalidate(billingProvider);
  if (error is! ApiException) return;
  if (error.code == 'MESSAGE_LIMIT_REACHED') {
    await showMessageAllowance(context);
  } else if (error.code == 'INSUFFICIENT_CREDITS') {
    await showBillingPaywall(
      context,
      creditsNeeded: PaywallCreditsNeeded.fromApiError(
        error,
        reason: 'Sending this message.',
      ),
    );
  }
}

Future<void> showMessageAllowance(BuildContext context, {bool refresh = true}) {
  if (refresh) {
    ProviderScope.containerOf(
      context,
      listen: false,
    ).invalidate(billingProvider);
  }
  return showAppBottomSheet<void>(
    context,
    builder: (_) => const _MessageAllowanceSheet(),
  );
}

class MessageAllowanceBanner extends ConsumerStatefulWidget {
  const MessageAllowanceBanner({super.key});

  @override
  ConsumerState<MessageAllowanceBanner> createState() =>
      _MessageAllowanceBannerState();
}

class _MessageAllowanceBannerState extends ConsumerState<MessageAllowanceBanner>
    with WidgetsBindingObserver {
  Timer? _timer;
  String? _refreshedToken;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      final allowance = ref
          .read(billingProvider)
          .asData
          ?.value
          .messageAllowance;
      if (allowance != null &&
          !allowance.resetsAt.isAfter(DateTime.now()) &&
          _refreshedToken != allowance.resetToken) {
        _refreshedToken = allowance.resetToken;
        ref.invalidate(billingProvider);
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) ref.invalidate(billingProvider);
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final allowance = ref.watch(billingProvider).asData?.value.messageAllowance;
    if (allowance == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Material(
        color: allowance.isExhausted
            ? theme.colorScheme.secondaryContainer
            : theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => showMessageAllowance(context),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(
                  allowance.isExhausted
                      ? Icons.hourglass_empty_rounded
                      : Icons.chat_bubble_outline_rounded,
                  size: 16,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    allowance.isExhausted
                        ? 'Daily message limit reached'
                        : '${allowance.remaining} of ${allowance.limit} messages left · '
                              '${allowance.creditsPerMessage} credits/message',
                    style: theme.textTheme.labelSmall,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  allowance.isExhausted && allowance.resetEnabled
                      ? 'Reset'
                      : 'Details',
                  style: theme.textTheme.labelMedium,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MessageAllowanceSheet extends ConsumerStatefulWidget {
  const _MessageAllowanceSheet();

  @override
  ConsumerState<_MessageAllowanceSheet> createState() =>
      _MessageAllowanceSheetState();
}

class _MessageAllowanceSheetState
    extends ConsumerState<_MessageAllowanceSheet> {
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final billing = ref.watch(billingProvider);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: billing.when(
          skipLoadingOnRefresh: false,
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(userFacingError(error)),
              TextButton(
                onPressed: () => ref.invalidate(billingProvider),
                child: const Text('Try again'),
              ),
            ],
          ),
          data: (value) {
            final allowance = value.messageAllowance;
            if (allowance == null) {
              return const Text('Message allowance unavailable.');
            }
            final localReset = allowance.resetsAt.toLocal();
            final resetLabel =
                '${MaterialLocalizations.of(context).formatMediumDate(localReset)} '
                'at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(localReset))}';
            final resetAvailable =
                allowance.isExhausted && allowance.resetEnabled;
            final needed = resetAvailable
                ? allowance.resetCredits
                : allowance.creditsPerMessage;
            final canAfford = value.credits.available >= needed;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  allowance.isExhausted
                      ? 'Daily message limit reached'
                      : 'Your daily messages',
                  style: theme.textTheme.headlineSmall,
                ),
                const SizedBox(height: 16),
                Text(
                  '${allowance.remaining} of ${allowance.limit} messages left',
                ),
                const SizedBox(height: 8),
                LinearProgressIndicator(
                  value: allowance.limit == 0
                      ? 0
                      : (allowance.remaining / allowance.limit).clamp(0, 1),
                ),
                const SizedBox(height: 16),
                Text(
                  '${allowance.creditsPerMessage} credits per message. Shared across all your chats.',
                ),
                const SizedBox(height: 8),
                Text('Refreshes $resetLabel (your local time).'),
                const SizedBox(height: 8),
                Text('Balance: ${value.credits.available} credits'),
                const SizedBox(height: 16),
                if (resetAvailable) ...[
                  Text(
                    'Reset for ${allowance.resetCredits} credits to get ${allowance.limit} more messages until the daily refresh. Message prices still apply.',
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy
                        ? null
                        : () => canAfford
                              ? _confirmReset(allowance)
                              : _addCredits(needed),
                    child: Text(
                      _busy
                          ? 'Resetting…'
                          : canAfford
                          ? 'Reset for ${allowance.resetCredits} credits'
                          : 'Add credits to reset',
                    ),
                  ),
                ] else if (allowance.isExhausted)
                  const Text(
                    'Credit resets are unavailable on your current plan. Your allowance refreshes automatically.',
                  )
                else if (!canAfford)
                  FilledButton(
                    onPressed: _busy ? null : () => _addCredits(needed),
                    child: const Text('Add credits to send messages'),
                  ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ],
                TextButton(
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: Text(
                    allowance.isExhausted ? 'Wait for daily refresh' : 'Done',
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _addCredits(int needed) async {
    await showBillingPaywall(
      context,
      creditsNeeded: PaywallCreditsNeeded(
        credits: needed,
        reason: 'Continuing your chat.',
      ),
    );
    if (mounted) ref.invalidate(billingProvider);
  }

  Future<void> _confirmReset(MessageAllowance allowance) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Reset message allowance?'),
        content: Text(
          'Spend ${allowance.resetCredits} credits for ${allowance.limit} more messages?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Confirm reset'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(messageAllowanceRepositoryProvider).reset(allowance);
      ref.invalidate(billingProvider);
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Message allowance reset. You can continue chatting.'),
        ),
      );
    } catch (error) {
      ref.invalidate(billingProvider);
      if (mounted) setState(() => _error = userFacingError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
