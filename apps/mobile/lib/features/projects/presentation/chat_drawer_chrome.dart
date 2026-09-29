import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/presentation/character_library_screen.dart';
import '../../studio/presentation/start_writing_sheet.dart';
import 'creation_chat_navigation.dart';

class ChatDrawerHeader extends StatelessWidget {
  const ChatDrawerHeader({super.key, required this.onSearchChats});

  /// Opens the chat search field. It is one tap away in the header rather than
  /// a standing field: the list is what the drawer is for, and a field that is
  /// always open costs a row of every screen height for something used rarely.
  final VoidCallback onSearchChats;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(20, 8, 8, 4),
      child: Row(
        children: [
          Expanded(
            // Two trailing icons on a 320-wide drawer at large text would
            // overflow the lockup; scale it down rather than clip the name
            // or the buttons.
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: AlignmentDirectional.centerStart,
                child: TomezaWordmark(
                  markSize: 25,
                  textStyle: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
          ),
          IconButton(
            key: const ValueKey('drawer-search-chats'),
            tooltip: 'Search chats',
            icon: const Icon(Icons.search),
            onPressed: onSearchChats,
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

/// A destination row at the top of the drawer: what it opens, how many things
/// are behind it, and a chevron that says it is a place rather than an action.
class DrawerNavRow extends StatelessWidget {
  const DrawerNavRow({
    required this.icon,
    required this.title,
    required this.onTap,
    this.subtitle,
    this.count,
    super.key,
  });

  final IconData icon;
  final String title;
  final String? subtitle;

  /// How many items are behind the row; null until it is known.
  final int? count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    // Own Material: the drawer paints a background colour, and a bare
    // ListTile's ink would vanish beneath it.
    return Material(
      type: MaterialType.transparency,
      child: ListTile(
        minTileHeight: AppSizes.minimumTouchTarget,
        contentPadding: const EdgeInsetsDirectional.only(start: 20, end: 12),
        horizontalTitleGap: 12,
        leading: Icon(icon, color: colors.onSurfaceVariant),
        title: Text(
          title,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: subtitle == null
            ? null
            : Text(
                subtitle!,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (count != null && count! > 0)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
                child: Text(
                  '$count',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            const SizedBox(width: 4),
            Icon(Icons.chevron_right, color: colors.onSurfaceVariant),
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}

/// Entry to the account-wide character library, sitting above "Your books":
/// characters outlive any one book the same way the shelf's books outlive any
/// one chat.
class DrawerCharactersRow extends ConsumerWidget {
  const DrawerCharactersRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Count only when the library is already cached — the row must not make
    // the drawer wait, and the screen behind it always loads fresh.
    final count = ref.watch(charactersProvider).asData?.value.characters.length;
    return DrawerNavRow(
      key: const ValueKey('drawer-characters-row'),
      icon: Icons.people_outline,
      title: 'Characters',
      subtitle: 'Reusable across all your books',
      count: count,
      onTap: () {
        AppHaptics.tap();
        Navigator.of(context).push<void>(
          MaterialPageRoute(builder: (_) => const CharacterLibraryScreen()),
        );
      },
    );
  }
}

/// The drawer's primary action, pinned above the account row.
///
/// It used to hover over the chat list, which meant it covered whichever row was
/// scrolled beneath it — usually the section label. Pinned in the footer it
/// stays put however far down a long history the reader has scrolled, and
/// nothing scrolls under it.
class ChatDrawerNewBookButton extends StatelessWidget {
  const ChatDrawerNewBookButton({super.key});

  @override
  Widget build(BuildContext context) {
    return AppButton.primary(
      label: 'New book',
      expanded: true,
      onPressed: () {
        AppHaptics.tap();
        Navigator.of(context).pop();
        context.go(newBookChatLocation());
      },
      leading: const Icon(Icons.edit_document),
    );
  }
}

/// The quiet second way to start a book, under the loud first one: a link, not
/// a button, so "New book" stays the one obvious thing to press.
class ChatDrawerWriteYourOwnLink extends StatelessWidget {
  const ChatDrawerWriteYourOwnLink({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: TextButton(
        key: const ValueKey('drawer-write-your-own'),
        style: TextButton.styleFrom(
          foregroundColor: theme.colorScheme.primary,
          visualDensity: VisualDensity.compact,
          textStyle: theme.textTheme.labelLarge?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        onPressed: () {
          // The drawer is closing, and its context goes with it; the sheet is
          // opened from the navigator that outlives it.
          final navigator = Navigator.of(context);
          navigator.pop();
          showStartWritingSheet(navigator.context);
        },
        child: const Text('or write your own'),
      ),
    );
  }
}

class ChatDrawerFooter extends StatelessWidget {
  const ChatDrawerFooter({
    required this.billing,
    required this.colors,
    this.offerWriteYourOwn = true,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;
  final ColorScheme colors;

  /// Whether the "or write your own" link sits under New book. It steps aside
  /// while the chats are being searched, and on a short screen, where the
  /// chats need every row they can get.
  final bool offerWriteYourOwn;

  @override
  Widget build(BuildContext context) {
    final credits = billing.whenOrNull(data: (b) => b.credits.available);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Divider(height: 1),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: ChatDrawerNewBookButton(),
        ),
        if (offerWriteYourOwn)
          const ChatDrawerWriteYourOwnLink()
        else
          const SizedBox(height: 4),
        Padding(
          padding: const EdgeInsetsDirectional.only(start: 8, end: 12),
          // A Wrap, not a Row: at large text the balance drops to its own line
          // instead of being cut to "1200 cr…".
          child: Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              AppButton.text(
                label: 'Account',
                onPressed: () {
                  Navigator.of(context).pop();
                  context.push('/account');
                },
                leading: const Icon(Icons.account_circle_outlined),
              ),
              if (credits != null) _CreditsPill(label: '$credits credits'),
            ],
          ),
        ),
        const SizedBox(height: 4),
      ],
    );
  }
}

/// The balance, as a tappable pill: the number matters more than the word, and
/// a tap goes where the reader would go to change it.
class _CreditsPill extends StatelessWidget {
  const _CreditsPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Semantics(
      button: true,
      label: '$label. Add credits',
      child: ExcludeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadii.pill),
          onTap: () {
            final navigator = Navigator.of(context);
            navigator.pop();
            showBillingPaywall(
              navigator.context,
              title: 'Add book credits',
              message:
                  'Credits are used when you approve a full book or unlock finished exports.',
            );
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Center(
                widthFactor: 1,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.toll_outlined,
                          size: 16,
                          color: colors.onSurfaceVariant,
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.labelMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
