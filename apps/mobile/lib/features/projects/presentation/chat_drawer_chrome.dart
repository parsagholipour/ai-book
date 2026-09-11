import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import 'creation_chat_navigation.dart';

class ChatDrawerHeader extends StatelessWidget {
  const ChatDrawerHeader({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: TomezaWordmark(
              markSize: 25,
              textStyle: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          IconButton(
            tooltip: 'Close',
            icon: const Icon(Icons.close),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

/// The drawer's primary action, hovering over the chat list rather than sitting
/// in its scroll flow. It hugs its label so the corner it floats in reads as a
/// deliberate anchor, and carries a shadow because chats scroll underneath it.
class ChatDrawerNewBookButton extends StatelessWidget {
  const ChatDrawerNewBookButton({super.key});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: ShapeDecoration(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.control),
        ),
        shadows: [
          BoxShadow(
            color: Theme.of(context).colorScheme.shadow.withValues(alpha: 0.28),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: AppButton.primary(
        label: 'New book',
        onPressed: () {
          AppHaptics.tap();
          Navigator.of(context).pop();
          context.go(newBookChatLocation());
        },
        leading: const Icon(Icons.edit_document),
      ),
    );
  }
}

class ChatDrawerFooter extends StatelessWidget {
  const ChatDrawerFooter({
    required this.billing,
    required this.colors,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;
  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    final creditLabel = billing.whenOrNull(
      data: (b) => '${b.credits.available} credits',
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      child: Row(
        children: [
          AppButton.text(
            label: 'Account',
            onPressed: () {
              Navigator.of(context).pop();
              context.push('/account');
            },
            leading: const Icon(Icons.account_circle_outlined),
          ),
          if (creditLabel != null) ...[
            const SizedBox(width: 8),
            Flexible(
              child: Align(
                alignment: Alignment.centerRight,
                child: Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Theme(
                    data: Theme.of(context).copyWith(
                      textButtonTheme: TextButtonThemeData(
                        style:
                            (Theme.of(context).textButtonTheme.style ??
                                    const ButtonStyle())
                                .copyWith(
                                  foregroundColor: WidgetStatePropertyAll(
                                    colors.onSurfaceVariant,
                                  ),
                                  textStyle: WidgetStatePropertyAll(
                                    Theme.of(context).textTheme.labelSmall,
                                  ),
                                ),
                      ),
                    ),
                    child: AppButton.text(
                      label: creditLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      onPressed: () {
                        final navigator = Navigator.of(context);
                        navigator.pop();
                        showBillingPaywall(
                          navigator.context,
                          title: 'Add book credits',
                          message:
                              'Credits are used when you approve a full book or unlock finished exports.',
                        );
                      },
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
